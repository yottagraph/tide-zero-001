# Nitro Server Routes

The `server/` directory contains Nuxt's Nitro server layer. These routes deploy
with the app to Vercel -- they are NOT a separate service. They handle
server-side concerns like prefs storage (per-tenant Firestore — ENG-520),
database access, and image proxying that can't run in the browser.

## Directory Layout

```
server/
├── api/
│   ├── prefs/               # Per-tenant Firestore prefs CRUD — read, write, delete, documents, collections, status (BC 2.0 default)
│   ├── kv/                  # Legacy KV CRUD — read, write, delete, documents, status (BC 1.0 tenants only)
│   └── avatar/[url].ts      # Avatar image proxy
└── utils/
    ├── firestore.ts         # firebase-admin client for the per-tenant Aether prefs Firestore (lazy-init from NUXT_FIRESTORE_SA_KEY)
    ├── localFsPrefsStore.ts # Local-FS prefs fallback for `npm run dev` (`.aether-dev-prefs/`)
    ├── redis.ts             # Upstash Redis client (lazy-init from KV_REST_API_URL) — BC 1.0 legacy
    ├── neon.ts              # Neon Postgres client (lazy-init from DATABASE_URL) — create if missing when Neon is provisioned
    └── cookies.ts            # Cookie handling (@hapi/iron)
```

For Firestore (BC 2.0 prefs) / KV (BC 1.0 prefs) / Neon Postgres access
(client usage, provisioning checks, creating tables, handling missing
credentials gracefully), see
[storage.md](storage.md) in this skill. For calling the platform Query
Server from Nitro routes, see [server-data.md](server-data.md) in this
skill.

## Adding Routes

Follow Nitro file-based routing. The filename determines the HTTP method and
path:

```
server/api/my-resource.get.ts      → GET  /api/my-resource
server/api/my-resource.post.ts     → POST /api/my-resource
server/api/my-resource/[id].get.ts → GET  /api/my-resource/:id
```

Route handler pattern:

```typescript
export default defineEventHandler(async (event) => {
    const params = getQuery(event); // query string
    const body = await readBody(event); // POST body
    const id = getRouterParam(event, 'id'); // path params

    // ... implementation ...
    return { result: 'data' };
});
```

## Key Differences from Client-Side Code

- Server routes run on the server (Node.js), not in the browser
- They have access to Firestore (firebase-admin), Redis (legacy KV),
  Neon Postgres, secrets, and server-only APIs
- They do NOT have access to Vue composables, Vuetify, or any client-side code
- Use `defineEventHandler`, not Vue component patterns

See [architecture.md](architecture.md) in this skill for the full data
architecture overview, [storage.md](storage.md) for Firestore / KV /
Postgres patterns, and [pref.md](pref.md) for client-side preferences.
