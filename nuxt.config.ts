// https://nuxt.com/docs/api/configuration/nuxt-config

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';

// Read tenant config from broadchurch.yaml (committed by tenant-init) so the
// runtime config has correct defaults even when .env is missing or stale.
// Env vars (from .env or Vercel) still take precedence via Nuxt's override.
function readBroadchurchYaml() {
    const empty = {
        found: false,
        appId: '',
        appName: '',
        gatewayUrl: '',
        tenantOrgId: '',
        queryServerAddress: '',
        auth0ClientId: '',
        qsApiKey: '',
    };
    try {
        if (!existsSync('broadchurch.yaml')) return empty;
        const yaml = readFileSync('broadchurch.yaml', 'utf-8');

        function sectionBlock(name: string): string {
            const re = new RegExp(`^${name}:\\s*$`, 'm');
            const idx = yaml.search(re);
            if (idx === -1) return '';
            const nl = yaml.indexOf('\n', idx);
            if (nl === -1) return '';
            const rest = yaml.slice(nl + 1);
            const end = rest.search(/^\S/m);
            return end === -1 ? rest : rest.slice(0, end);
        }

        function urlFrom(section: string): string {
            const m = sectionBlock(section).match(/url:\s*["']?(https?:\/\/[^\s"']+)/);
            return m ? m[1] : '';
        }

        function valueFrom(section: string, key: string): string {
            const m = sectionBlock(section).match(new RegExp(`${key}:\\s*["']?([^\\s"'#]+)`));
            return m ? m[1] : '';
        }

        return {
            found: true,
            appId: valueFrom('tenant', 'project_name'),
            appName: valueFrom('tenant', 'display_name'),
            gatewayUrl: urlFrom('gateway'),
            tenantOrgId: valueFrom('tenant', 'org_id'),
            queryServerAddress: urlFrom('query_server'),
            auth0ClientId: valueFrom('auth', 'client_id'),
            qsApiKey: valueFrom('gateway', 'qs_api_key'),
        };
    } catch {
        return empty;
    }
}

const bcYaml = readBroadchurchYaml();

export default defineNuxtConfig({
    devtools: { enabled: false },

    devServer: {
        host: '0.0.0.0',
    },

    ssr: false,

    app: {
        baseURL: '/',
        head: {},
    },

    nitro: {
        preset: process.env.VERCEL ? 'vercel' : undefined,
        ...(!process.env.VERCEL && {
            output: {
                publicDir: '.output/public',
            },
        }),
    },

    modules: ['vuetify-nuxt-module'],

    vuetify: {
        vuetifyOptions: {
            theme: {
                defaultTheme: 'lovelaceDark',
                themes: {
                    lovelaceDark: {
                        dark: true,
                        colors: {
                            background: '#0a0a0a',
                            surface: '#141414',
                            'surface-variant': '#1c1c1c',
                            primary: '#3fea00',
                            secondary: '#003bff',
                            warning: '#ff5c00',
                            error: '#ef4444',
                            info: '#003bff',
                            success: '#3fea00',
                            'on-background': '#e5e5e5',
                            'on-surface': '#e5e5e5',
                        },
                    },
                },
            },
            defaults: {
                VBtn: { variant: 'flat', rounded: 'lg' },
                VCard: { rounded: 'lg', variant: 'outlined' },
                VTextField: { variant: 'outlined', density: 'comfortable', color: 'primary' },
                VSelect: { variant: 'outlined', density: 'comfortable', color: 'primary' },
                VChip: { size: 'small', variant: 'tonal' },
                VDialog: {
                    VCard: { variant: 'flat' },
                },
            },
        },
    },

    // Remove utils/ from auto-import scanning. Nuxt scans composables/ and utils/
    // by default and `imports.dirs` only ADDS directories, it doesn't replace them.
    // The utils/ scan causes false-positive exports (function parameters like 'options'
    // get detected as named exports → SyntaxError → blank page at runtime).
    //
    // Also remove any composables/_internal/ subdirs. Files placed there are
    // genuinely internal (e.g. `composables/_internal/usePrefsRoot.ts` —
    // shared bootstrap machinery for the prefs API that consumers MUST NOT
    // touch directly) and should not bleed into the auto-import scope.
    // Tenant features can still place "private to this app" files inside
    // their own `_internal/` to opt out of auto-import the same way.
    //
    // Note: this opt-out is type-level enforcement only. `nuxt build` does
    // not typecheck; a bare reference to an `_internal/` export compiles
    // into a runtime `ReferenceError`. Wire `nuxi typecheck` into CI for
    // build-time safety. See `.agents/skills/aether/pref.md`.
    hooks: {
        'imports:dirs': (dirs: string[]) => {
            for (let i = dirs.length - 1; i >= 0; i--) {
                if (dirs[i].endsWith('/utils') || dirs[i].includes('/_internal')) {
                    dirs.splice(i, 1);
                }
            }
        },
    },

    css: ['~/assets/fonts.css', '~/assets/brand-globals.css', '~/assets/theme-styles.css'],

    // Runtime configuration with sensible defaults
    // Nuxt automatically overrides these with environment variables following the pattern:
    // NUXT_PUBLIC_[KEY_NAME] for public config (e.g., NUXT_PUBLIC_APP_ID overrides appId)
    // See: https://nuxt.com/docs/guide/going-further/runtime-config
    runtimeConfig: {
        public: {
            qsApiKey: bcYaml.qsApiKey,
            // App Identity — broadchurch.yaml provides defaults for provisioned projects
            appId: bcYaml.appId,
            appName: bcYaml.appName,
            appShortName: 'Elemental',

            // Auth0 Configuration
            auth0Audience: '',
            auth0ClientId: bcYaml.auth0ClientId,
            auth0ClientSecret: '',
            auth0CookieName: 'llai-cookie',
            auth0IssuerBaseUrl: 'https://auth.lovelace.ai',
            cookieSecret: 'Our-cool-elemental-cookie-secret',

            // Server Configuration
            queryServerAddress: bcYaml.queryServerAddress,

            // Agent Gateway
            gatewayUrl: bcYaml.gatewayUrl,
            tenantOrgId: bcYaml.tenantOrgId,
            agents: '',

            // BigQuery (BC 2.0 per-tenant data plane) — overridden by
            // NUXT_PUBLIC_BIGQUERY_* env vars on tenants provisioned with
            // BigQuery enabled. Default empty so pages can render a
            // "BigQuery is not configured" state in local dev.
            // See `.agents/skills/aether/bigquery.md` for usage.
            bigqueryEnabled: '',
            bigqueryProjectId: '',
            bigqueryDatasetId: '',
            bigqueryLocation: '',

            // Firestore (BC 2.0 prefs backend — ENG-520). Overridden by
            // NUXT_PUBLIC_FIRESTORE_* env vars on tenants provisioned
            // with Firestore enabled. The server-only credential
            // `NUXT_FIRESTORE_SA_KEY` is read from `process.env`
            // directly inside `server/utils/firestore.ts` so it never
            // ships to the client bundle. See `.agents/skills/aether/pref.md`.
            firestoreEnabled: '',
            firestoreProjectId: '',
            firestoreDatabaseId: '(default)',
            firestoreLocation: '',

            // User Configuration — bypass Auth0 in dev mode for provisioned projects
            userName: bcYaml.found && process.env.NODE_ENV !== 'production' ? 'dev-user' : '',

            // App Configuration
            versionString: 'release_internal-dev',
        },
    },

    vite: {
        build: {
            target: 'esnext', //browsers can handle the latest ES features
        },
        define: {
            'process.env.NODE_DEBUG': JSON.stringify(''),
        },
        optimizeDeps: {
            include: ['vuetify'],
            esbuildOptions: {
                define: {
                    global: 'globalThis',
                },
            },
        },
        resolve: {
            dedupe: ['vue', 'vue-router', 'vuetify'],
            preserveSymlinks: true,
        },
    },

    compatibilityDate: '2025-08-25',
});
