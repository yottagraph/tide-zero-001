import { initializeApp, getApps, cert, type App, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * Firebase Admin SDK wrapper for the per-tenant Aether prefs Firestore
 * database (ENG-520).
 *
 * Replaces the BC 1.0 Upstash KV detour. Initialization is lazy and
 * idempotent: the first call to `getFirestoreDb()` reads the SA key
 * out of `NUXT_FIRESTORE_SA_KEY` (base64-encoded JSON; injected by the
 * portal during BC 2.0 provisioning + `enable_firestore`), parses it,
 * and registers a `firebase-admin` app named `aether-prefs` against
 * the tenant's per-tenant GCP project + database.
 *
 * `isFirestoreConfigured()` lets routes 404 cleanly during local dev
 * (no SA key on disk → routes return null/empty and the LocalFsPrefsStore
 * takes over on the client). The runtime check uses the
 * `NUXT_PUBLIC_FIRESTORE_ENABLED` flag plus presence of the SA key — both
 * must be set.
 */

const APP_NAME = 'aether-prefs';

let _app: App | null = null;
let _db: Firestore | null = null;

function isEnabled(): boolean {
    return (
        process.env.NUXT_PUBLIC_FIRESTORE_ENABLED === 'true' &&
        !!process.env.NUXT_FIRESTORE_SA_KEY &&
        !!process.env.NUXT_PUBLIC_FIRESTORE_PROJECT_ID
    );
}

function decodeSaKey(raw: string): ServiceAccount {
    // The portal injects the SA key as base64-encoded JSON (matches the
    // `privateKeyData` field returned by the IAM `serviceAccounts.keys.create`
    // API). Operators may set the env var as plain JSON when wiring
    // local dev or staging — try base64 decode first and fall back to
    // raw JSON for friendliness.
    let jsonText: string;
    try {
        jsonText = Buffer.from(raw, 'base64').toString('utf-8');
        if (!jsonText.trimStart().startsWith('{')) {
            jsonText = raw;
        }
    } catch {
        jsonText = raw;
    }
    const parsed = JSON.parse(jsonText) as Record<string, string>;
    return {
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
    };
}

/**
 * Return the Firestore Admin SDK handle for the per-tenant database,
 * or `null` when Firestore is not configured (BC 1.0 tenant on KV,
 * local dev without an SA key, etc.). Routes should return early in
 * that case so the client-side store can fall back.
 */
export function getFirestoreDb(): Firestore | null {
    if (_db) return _db;
    if (!isEnabled()) return null;

    if (_app) {
        _db = getFirestore(_app, process.env.NUXT_PUBLIC_FIRESTORE_DATABASE_ID || '(default)');
        return _db;
    }

    const existing = getApps().find((a) => a.name === APP_NAME);
    if (existing) {
        _app = existing;
    } else {
        const credential = cert(decodeSaKey(process.env.NUXT_FIRESTORE_SA_KEY!));
        _app = initializeApp(
            {
                credential,
                projectId: process.env.NUXT_PUBLIC_FIRESTORE_PROJECT_ID!,
            },
            APP_NAME
        );
    }

    _db = getFirestore(_app, process.env.NUXT_PUBLIC_FIRESTORE_DATABASE_ID || '(default)');
    // REST transport avoids the gRPC + ADC re-auth dance and matches
    // what the portal's `firestore.ts` does for the central database.
    _db.settings({ preferRest: true });
    return _db;
}

/**
 * Whether the runtime is configured to talk to a per-tenant Firestore.
 * Used by `/api/prefs/status` to surface a clean "Firestore is not
 * configured" signal to the client store so it can degrade to the
 * local-FS implementation (`localFsPrefsStore.ts`) without spamming
 * 500s.
 */
export function isFirestoreConfigured(): boolean {
    return isEnabled();
}

/**
 * Whether the local-filesystem fallback (`.aether-dev-prefs/`) should
 * be used in place of Firestore. True for `npm run dev` against
 * aether-dev when no Firestore credentials are set — gives developers
 * persistence-across-refreshes without standing up a real Firestore.
 *
 * Production deploys ALWAYS go through `getFirestoreDb()`; this
 * fallback is intentionally locked to non-production NODE_ENV so a
 * mis-configured Vercel build can't silently fall back to a
 * filesystem that won't exist after the next deployment.
 */
export function shouldUseLocalFsFallback(): boolean {
    if (isEnabled()) return false;
    if (process.env.NODE_ENV === 'production') return false;
    return true;
}
