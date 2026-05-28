# BigQuery

The tenant app reads BigQuery through the **Broadchurch Portal gateway**.
The Vercel-hosted Aether app NEVER holds GCP credentials directly — the
portal runs queries in the tenant's per-tenant GCP project on the app's
behalf, using its own service account.

| Capability                | How to check                                                      | Env var                                                                                               | Utility file                                |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **BigQuery (analytical)** | `process.env.NUXT_PUBLIC_BIGQUERY_ENABLED === 'true'`             | `NUXT_PUBLIC_BIGQUERY_ENABLED`                                                                        | `server/utils/bigquery.ts` (pre-scaffolded) |
|                           | OR `curl <gateway.url>/api/tenants/<org_id>` → `gcp.bigquery` set | `NUXT_PUBLIC_BIGQUERY_DATASET_ID`, `NUXT_PUBLIC_BIGQUERY_PROJECT_ID`, `NUXT_PUBLIC_BIGQUERY_LOCATION` |                                             |

Only available if the tenant was provisioned with BigQuery enabled (or
had it enabled later via the portal's "Enable BigQuery" action). Check
`isBigQueryConfigured()` before calling any of the helpers.

For transactional / relational data see [storage.md](storage.md)
(Postgres + KV); BigQuery is the analytical store, optimized for
append-only / large columnar scans.

## Critical: never do these

The agent reflexively reaches for `@google-cloud/bigquery` and a
service-account-key env var when asked to talk to BigQuery — that's the
**BC 1.0 pattern** and it is not supported here. If you find yourself
about to write any of these, **stop**, re-read this file, and use
`server/utils/bigquery.ts` instead:

- DO NOT add `@google-cloud/bigquery` to `package.json`. It only ships
  with the Broadchurch Portal where the SA actually exists; in the
  tenant app it would fail at runtime with "could not load default
  credentials".
- DO NOT paste a JSON service-account key into Vercel env (as
  `GCP_SERVICE_ACCOUNT_KEY` or any other name). There is no key for the
  app to use — the portal is what holds credentials. The Vercel env is
  also not a secure place to put long-lived GCP keys.
- DO NOT add `GOOGLE_APPLICATION_CREDENTIALS`. That env var points at a
  key file on disk; Vercel has no such file and no way to obtain one.
- DO NOT call the BigQuery REST API directly from `<script setup>` or
  any client-side code. Always go through a Nitro server route
  (`server/api/**`).

## Where credentials come from

There is no credential on the tenant side. The portal gateway resolves
the tenant's GCP project from `org_id` (passed in the URL) and runs
jobs with the portal SA's ADC. Inside `bc-{slug}` the portal SA has:

- `roles/bigquery.jobUser` + `roles/bigquery.metadataViewer` at the
  project level (list datasets/tables, run SELECT jobs).
- `roles/bigquery.dataEditor` on `bc_{slug}_analytics` (read row data).

That last binding scopes read access: the picker can list every dataset
the agent or tenant has created in the project, but `runQuery()` will
fail on datasets the portal hasn't been ACL'd into. The intended
analytical write target is `bc_{slug}_analytics`.

## `isBigQueryConfigured()` — feature gating

The provisioner injects `NUXT_PUBLIC_BIGQUERY_ENABLED=true` into the
Vercel env when BQ is on. Use it to gate UI:

```vue
<script setup lang="ts">
    const bqEnabled = useRuntimeConfig().public.bigqueryEnabled === 'true';
</script>

<template>
    <v-card v-if="bqEnabled">…analytics UI…</v-card>
    <v-card v-else>
        <v-card-title>BigQuery is not configured</v-card-title>
        <v-card-text> Ask the platform operator to enable BigQuery for this app. </v-card-text>
    </v-card>
</template>
```

For server routes, use `isBigQueryConfigured()` from
`server/utils/bigquery.ts` and return a 503-style message when it's
false (don't throw — the page should still render).

## Server-route pattern

All BQ access lives in `server/api/**`. Helpers exposed by
`server/utils/bigquery.ts`:

| Helper                            | Returns                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isBigQueryConfigured()`          | `boolean`                                                                                                                                              |
| `getDefaultDataset()`             | `string \| null` — `bc_{slug}_analytics`                                                                                                               |
| `getBigQueryProjectId()`          | `string \| null` — `bc-{slug}`                                                                                                                         |
| `getBigQueryLocation()`           | `string \| null` — e.g. `us-central1`                                                                                                                  |
| `listDatasets()`                  | `BqDataset[]`                                                                                                                                          |
| `listTables(datasetId, options?)` | `BqTable[]`                                                                                                                                            |
| `runQuery(sql, options?)`         | `BqQueryResult` (read-only: SELECT / WITH / CALL)                                                                                                      |
| `runMutation(sql, options?)`      | `BqMutationResult` (writes: DML + table/view/schema DDL)                                                                                               |
| `toRowObjects(result)`            | `Record<string, unknown>[]` — values are raw BQ wire-format strings; see [Wire-format gotcha](#wire-format-gotcha-torowobjects-returns-raw-bq-strings) |

### Which helper to use

| You want to …                                                 | Use                   | Notes                                                       |
| ------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| Run a SELECT, list rows from a view, etc.                     | `runQuery`            | 10 k row cap, 30 s timeout, 10 GB scan cap                  |
| Insert / update / delete rows                                 | `runMutation`         | parameterise — never string-interpolate user input          |
| Create a new table or schema (incl. `CREATE TABLE AS SELECT`) | `runMutation`         | 60 s timeout; long DDL returns `{ pending: true }`          |
| Drop / alter a table or view                                  | `runMutation`         | irreversible — confirm before calling                       |
| Anything else (CALL, GRANT, EXPORT DATA, …)                   | (none — out of scope) | open an issue if you need it; do not hand-roll a workaround |

### Example: list datasets

```typescript
// server/api/bq/datasets.get.ts
import { isBigQueryConfigured, listDatasets } from '~/server/utils/bigquery';

export default defineEventHandler(async () => {
    if (!isBigQueryConfigured()) {
        throw createError({ statusCode: 503, statusMessage: 'BigQuery not configured' });
    }
    return await listDatasets();
});
```

### Example: list tables in a dataset

```typescript
// server/api/bq/tables/[dataset].get.ts
import { isBigQueryConfigured, listTables } from '~/server/utils/bigquery';

export default defineEventHandler(async (event) => {
    if (!isBigQueryConfigured()) {
        throw createError({ statusCode: 503, statusMessage: 'BigQuery not configured' });
    }
    const dataset = getRouterParam(event, 'dataset');
    if (!dataset) {
        throw createError({ statusCode: 400, statusMessage: 'dataset is required' });
    }
    return await listTables(dataset);
});
```

### Example: run a parameterized SELECT

```typescript
// server/api/bq/events.get.ts
import { isBigQueryConfigured, runQuery, toRowObjects } from '~/server/utils/bigquery';

export default defineEventHandler(async (event) => {
    if (!isBigQueryConfigured()) {
        throw createError({ statusCode: 503, statusMessage: 'BigQuery not configured' });
    }
    const { date, limit } = getQuery(event);
    const result = await runQuery(
        `SELECT * FROM events WHERE event_date = @date ORDER BY ts DESC LIMIT @limit`,
        {
            params: [
                { name: 'date', type: 'DATE', value: String(date ?? '2026-01-01') },
                { name: 'limit', type: 'INT64', value: Number(limit ?? 100) },
            ],
        }
    );
    return {
        schema: result.schema,
        rows: toRowObjects(result),
        truncated: result.truncated,
    };
});
```

`defaultDataset` is set automatically to `bc_{slug}_analytics` for
unqualified table refs. Pass `options.defaultDataset` to override.

### Example: insert rows with `runMutation`

```typescript
// server/api/bq/events.post.ts
import { isBigQueryConfigured, runMutation } from '~/server/utils/bigquery';

export default defineEventHandler(async (event) => {
    if (!isBigQueryConfigured()) {
        throw createError({ statusCode: 503, statusMessage: 'BigQuery not configured' });
    }
    const body = await readBody<{ id: string; value: number }>(event);
    const result = await runMutation(
        `INSERT INTO events (id, value, inserted_at) VALUES (@id, @value, CURRENT_TIMESTAMP())`,
        {
            params: [
                { name: 'id', type: 'STRING', value: body.id },
                { name: 'value', type: 'INT64', value: body.value },
            ],
        }
    );
    return {
        inserted: result.numDmlAffectedRows,
        jobId: result.jobId,
        pending: result.pending,
    };
});
```

### Example: bootstrap a table the agent's app needs

```typescript
// server/api/bq/admin/init-events-table.post.ts
import { isBigQueryConfigured, runMutation } from '~/server/utils/bigquery';

export default defineEventHandler(async () => {
    if (!isBigQueryConfigured()) {
        throw createError({ statusCode: 503, statusMessage: 'BigQuery not configured' });
    }
    await runMutation(`
        CREATE TABLE IF NOT EXISTS events (
            id STRING NOT NULL,
            value INT64,
            inserted_at TIMESTAMP NOT NULL
        )
        PARTITION BY DATE(inserted_at)
        CLUSTER BY id
    `);
    return { ok: true };
});
```

### Destructive verbs — confirm before calling

`runMutation` will happily run `DROP TABLE`, `TRUNCATE`, or
`DELETE` without a `WHERE`. The gateway doesn't second-guess
intent — the UI must. Pattern:

```vue
<script setup lang="ts">
    async function dropTable(name: string) {
        const ok = window.confirm(
            `This permanently deletes the table ${name} and all its data. Continue?`
        );
        if (!ok) return;
        await $fetch(`/api/bq/tables/${name}`, { method: 'DELETE' });
    }
</script>
```

## Wire-format gotcha: `toRowObjects()` returns raw BQ strings

`toRowObjects()` does NOT decode BigQuery's wire-format scalars into
the obvious JavaScript types. Every value comes back as a string,
keyed by column name. The caller is responsible for parsing.

| BQ type     | Wire format you'll receive                                              | How to parse                                                                             |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `STRING`    | the string itself                                                       | use as-is                                                                                |
| `INT64`     | a decimal string (e.g. `"42"`)                                          | `Number(v)` or `BigInt(v)` if it might exceed `Number.MAX_SAFE_INTEGER`                  |
| `FLOAT64`   | a decimal string (e.g. `"3.14"`)                                        | `Number(v)`                                                                              |
| `BOOL`      | `"true"` / `"false"`                                                    | `v === 'true'`                                                                           |
| `DATE`      | ISO date string (e.g. `"2026-05-19"`)                                   | `new Date(v)` or use as-is                                                               |
| `TIMESTAMP` | **fractional Unix epoch seconds** as a string (e.g. `"1779242063.072"`) | `new Date(Number(v) * 1000)` — NOT `new Date(v)`, which silently produces `Invalid Date` |
| `DATETIME`  | ISO datetime without zone (e.g. `"2026-05-19T20:00:00"`)                | `new Date(v + 'Z')` if you want UTC                                                      |
| `JSON`      | the JSON-encoded string                                                 | `JSON.parse(v)`                                                                          |
| `BYTES`     | base64                                                                  | `atob(v)` / `Buffer.from(v, 'base64')`                                                   |

`TIMESTAMP` is the one that catches every agent: passing the wire
value straight to `new Date()` produces `Invalid Date` because JS
doesn't recognise fractional epoch seconds. A standard helper to keep
in any page that renders timestamps:

```typescript
function formatTimestamp(raw: string | null | undefined): string {
    if (!raw) return '';
    const asNumber = Number(raw);
    const date = Number.isFinite(asNumber) ? new Date(asNumber * 1000) : new Date(raw);
    if (Number.isNaN(date.getTime())) return String(raw);
    return date.toLocaleString();
}
```

The fallback to `new Date(raw)` keeps this helper safe if a future BQ
client (or a JOIN that produces `DATETIME`) ever returns ISO strings
instead.

If you want typed values without writing per-column parsers, do the
casting in SQL with `UNIX_MILLIS(ts)` or `FORMAT_TIMESTAMP('%FT%T%Ez', ts)`
before `SELECT`ing — BQ will still return a string, but it'll be one
that `new Date()` accepts.

## Guardrails the gateway enforces

|                      | Read (`runQuery` / `/query`)                                                                          | Write (`runMutation` / `/mutation`)                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Allowed verbs        | `SELECT`, `WITH`, `CALL`                                                                              | `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `DROP`, `ALTER` |
| Refused verbs        | DML, DDL, `CREATE`/`DROP`                                                                             | `SELECT`, `WITH`, `CALL`, `GRANT`, `REVOKE`, `EXPORT DATA`, `LOAD DATA`      |
| Bytes scanned cap    | 10 GB (default 1 GB)                                                                                  | 10 GB (default 1 GB)                                                         |
| Row cap              | 10,000 per call (default 1,000)                                                                       | n/a — DML/DDL doesn't return rows                                            |
| Wall-clock           | 30 s; sets `truncated: true` if BQ ran out of time                                                    | 60 s; sets `pending: true` if BQ ran out of time (job continues server-side) |
| Cross-project safety | Portal SA only has roles inside the tenant's GCP project — cross-project references 403 at the BQ API | Same                                                                         |

For row-by-row append from a long-running job, prefer a compute job
(K8s Job) or Workflow in the tenant project writing directly via the
official BQ client — the sync gateway is the wrong tool for streaming
inserts.

## Local dev

`NUXT_PUBLIC_BIGQUERY_*` are intentionally unset in local `.env`.
`isBigQueryConfigured()` returns false, helpers throw with a clear
message ("BigQuery is not configured for this tenant…"). Test BQ
features on the deployed preview/production URL where the env vars
are injected.

## Where the data goes

Compute jobs (K8s Jobs on the per-tenant GKE cluster) and Workflows
in the tenant project write to `bc_{slug}_analytics` (see
[`compute.md`](compute.md) and [`deployment.md`](deployment.md)). The
tenant app reads from that dataset
through this gateway. Round-trip:

```
Compute job (K8s) → BigQuery (bc_{slug}_analytics) → Portal gateway → Aether app
                                                       ↑
                                                  portal SA's ADC
```

If you see "Permission denied on resource project" in the gateway
response, the dataset's IAM was likely created in a previous tenant
version and is missing the portal SA. Re-run "Enable BigQuery" in the
portal cockpit to reconcile.
