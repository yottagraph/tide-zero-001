# Storage

This skill covers **transactional / state** storage — per-tenant
Firestore (always on for BC 2.0 tenants — ENG-520), the legacy KV
store (BC 1.0 tenants only), and Neon Postgres / Cloud SQL (if
provisioned). For **analytical / append-only** reads from large
datasets, see [`bigquery.md`](bigquery.md) — BigQuery is provisioned
per-tenant in the GCP tenant project and read through the portal
gateway.

| Store                  | How to check                                                                      | Env var                                             | Utility file                                              | Always available?                   |
| ---------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| **Firestore** (prefs)  | `NUXT_PUBLIC_FIRESTORE_ENABLED=true` in `.env`                                    | `NUXT_PUBLIC_FIRESTORE_*` + `NUXT_FIRESTORE_SA_KEY` | `server/utils/firestore.ts` (pre-scaffolded)              | Yes for BC 2.0 tenants              |
| **KV** (Upstash Redis) | `KV_REST_API_URL` in `.env` (BC 1.0 only)                                         | `KV_REST_API_URL`, `KV_REST_API_TOKEN`              | `server/utils/redis.ts` (pre-scaffolded)                  | Yes for BC 1.0 tenants              |
| **Neon Postgres**      | `curl <gateway.url>/api/tenants/<tenant.org_id>` → `vercel.postgres_store_id` set | `DATABASE_URL`, `DATABASE_URL_UNPOOLED`             | `server/utils/neon.ts` (create it if missing — see below) | Only if enabled at project creation |

For client-side user preferences that sit on top of Firestore (or KV
on legacy tenants), see [pref.md](pref.md) in this skill — that's the
right entrypoint for almost every prefs use case.

## Where credentials come from

**Deployed builds** (push to `main` → Vercel): storage env vars are
auto-injected and decrypted at runtime. Storage works with zero
configuration. **This is the primary development path** — push your code
and test on the deployed preview/production URL.

**Local dev / Cursor Cloud:**

- **Firestore prefs** — `npm run dev` falls back to a local-filesystem
  store at `.aether-dev-prefs/`. `useAppPrefs` / `useGlobalPrefs` /
  `useAppFeaturePrefs` / `useGlobalFeaturePrefs` persist across page
  refreshes without any cloud setup. Production builds never use the
  fallback. See [pref.md](pref.md) for details.
- **Neon Postgres** — credentials are not yet available for local use.
  `getDb()` returns `null`; routes should handle the case (return a
  "database not configured" state or empty payload).

## Firestore (BC 2.0 prefs backend)

`server/utils/firestore.ts` is the per-tenant Firestore wrapper. It
inits `firebase-admin` from `NUXT_FIRESTORE_SA_KEY` (base64-encoded
service-account JSON, injected by the portal) and the
`NUXT_PUBLIC_FIRESTORE_PROJECT_ID` / `NUXT_PUBLIC_FIRESTORE_DATABASE_ID`
pair. Use `getFirestoreDb()` from server routes that need raw doc/
collection access; almost everything client-facing should go through
the prefs composables in [pref.md](pref.md).

```typescript
import { getFirestoreDb } from '~/server/utils/firestore';

const db = getFirestoreDb();
if (db) {
    // Example: a server-side ETL writing to its own per-tenant collection.
    await db.doc('etl/last-run').set({ at: Date.now() }, { merge: true });
}
```

`getFirestoreDb()` returns `null` when Firestore isn't configured (BC 1.0
tenant on KV, or local dev with the FS fallback). The pre-scaffolded
`/api/prefs/*` routes already handle the fallback case — only call
`getFirestoreDb()` directly when you need doc/collection access outside
the prefs surface.

## KV (Upstash Redis — legacy BC 1.0 only)

`server/utils/redis.ts` initializes the Upstash Redis client from env vars
that Vercel auto-injects when a KV store is connected:

- `KV_REST_API_URL` — Redis REST API endpoint
- `KV_REST_API_TOKEN` — Auth token

```typescript
import { getRedis, toRedisKey } from '~/server/utils/redis';

const redis = getRedis();
if (redis) {
    await redis.hset(toRedisKey('/users/abc/settings'), { theme: 'dark' });
    const theme = await redis.hget(toRedisKey('/users/abc/settings'), 'theme');
}
```

Returns `null` if KV is not configured (env vars missing). Always check
before using. Note: new BC 2.0 tenants don't get a KV store — the
portal provisions a per-tenant Firestore instead (see above and
[pref.md](pref.md)). The KV utility + `/api/kv/*` routes stay in the
template so legacy BC 1.0 tenants (Convergence, etc.) keep working
unchanged.

For client-side preferences, use the prefs composables
(`useAppPrefs` / `useGlobalPrefs` / `useAppFeaturePrefs` /
`useGlobalFeaturePrefs`) instead of calling KV routes directly —
see [pref.md](pref.md) in this skill. (BC 1.0 KV-backed tenants
reach the same composables; the client picks the right backend
automatically.)

## Neon Postgres

Neon provisioning is decided by the portal, not by what is in `.env`.
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` are intentionally left commented
out locally — Neon does not work in local dev. On deploy, Vercel
auto-injects `DATABASE_URL` at runtime.

### How to check

Pull `gateway.url` and `tenant.org_id` out of `broadchurch.yaml` and ask the
portal:

```bash
curl <gateway.url>/api/tenants/<tenant.org_id>
```

- Provisioned: `vercel.postgres_store_id` is set in the response. The
  `DATABASE_URL` is also findable under `agent_secrets`, but you usually
  don't need to read it.
- `server/utils/neon.ts` present → ready to use. If missing, create it
  (see "If `server/utils/neon.ts` doesn't exist" below).
- `@neondatabase/serverless` in `package.json` → ready. If missing, run
  `npm install @neondatabase/serverless`.

**Local dev:** `DATABASE_URL` is not yet available for local development.
`getDb()` returns `null` when the credential is missing or invalid. Write
your server routes to handle this gracefully (return a "database not
configured" error or empty state). Push to `main` to test with a real
database on the deployed build, where credentials are auto-injected.

### Usage

`server/utils/neon.ts` exports `getDb()` (same lazy-init pattern as
`getRedis()` in `redis.ts`): returns a query function or `null` if
`DATABASE_URL` is not set.

```typescript
import { getDb } from '~/server/utils/neon';

export default defineEventHandler(async () => {
    const sql = getDb();
    if (!sql) throw createError({ statusCode: 503, statusMessage: 'Database not configured' });

    const rows = await sql`SELECT * FROM notes ORDER BY created_at DESC`;
    return rows;
});
```

The Neon driver uses tagged template literals for automatic SQL injection
protection — `await sql\`SELECT \* FROM notes WHERE id = ${id}\`` is safe.
No ORM, no query builder, no connection pool setup needed.

### Creating tables

There is no migrations framework. Use `CREATE TABLE IF NOT EXISTS` directly
in a setup route or at the top of a route that needs the table:

```typescript
const sql = getDb()!;
await sql`CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`;
```

For simple apps, putting `CREATE TABLE IF NOT EXISTS` in each route that
uses the table is fine — it's a no-op after the first call. For more complex
schemas, create a `server/api/db/setup.post.ts` route that initializes all
tables.

### Handle missing tables in GET routes

Tables created by POST/setup routes won't exist on a fresh deployment.
**Every GET route that queries a table must handle the case where the table
doesn't exist yet.** Without this, fresh deploys will 500 on every page load
until the setup route runs.

```typescript
export default defineEventHandler(async () => {
    const sql = getDb();
    if (!sql) throw createError({ statusCode: 503, statusMessage: 'Database not configured' });

    try {
        const rows = await sql`SELECT * FROM companies ORDER BY updated_at DESC`;
        return rows;
    } catch (err: any) {
        if (err.message?.includes('does not exist')) {
            return [];
        }
        throw err;
    }
});
```

Alternatively, ensure tables exist before querying by calling
`CREATE TABLE IF NOT EXISTS` at the top of each GET route, or by calling a
shared setup function:

```typescript
// server/utils/ensure-tables.ts
import { getDb } from '~/server/utils/neon';

let _initialized = false;

export async function ensureTables() {
    if (_initialized) return;
    const sql = getDb();
    if (!sql) return;

    await sql`CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    neid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;

    _initialized = true;
}
```

Then call `await ensureTables()` at the start of any route that reads the
table. The `_initialized` flag makes it a no-op after the first call within
the same serverless invocation.

### If `server/utils/neon.ts` doesn't exist

Create it manually (or re-run init):

```bash
npm install @neondatabase/serverless
```

```typescript
// server/utils/neon.ts
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let _sql: NeonQueryFunction | null = null;

export function isDbConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL);
}

export function getDb(): NeonQueryFunction | null {
    if (_sql) return _sql;
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    _sql = neon(url);
    return _sql;
}
```
