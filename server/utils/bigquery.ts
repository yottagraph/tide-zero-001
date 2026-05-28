/**
 * BigQuery client for the tenant Aether app.
 *
 * ╔════════════════════════════════════════════════════════════════════╗
 * ║                  DO NOT REPLACE OR REWRITE THIS FILE               ║
 * ║                                                                    ║
 * ║  This is the *only* sanctioned way for a tenant Aether app to      ║
 * ║  reach BigQuery. It proxies through the Broadchurch Portal         ║
 * ║  gateway, which runs the actual jobs in the per-tenant GCP         ║
 * ║  project using the portal's service account.                       ║
 * ║                                                                    ║
 * ║  If you (the AI agent) are thinking about:                         ║
 * ║    • `npm install @google-cloud/bigquery`        ← STOP            ║
 * ║    • pasting a `GOOGLE_SERVICE_ACCOUNT_KEY` env  ← STOP            ║
 * ║    • setting `GOOGLE_APPLICATION_CREDENTIALS`    ← STOP            ║
 * ║    • writing your own BigQuery client            ← STOP            ║
 * ║                                                                    ║
 * ║  The reason: the tenant Vercel app cannot hold GCP credentials.    ║
 * ║  Asking the user to paste a service-account JSON is a known        ║
 * ║  UX failure — they don't have one and shouldn't need one.          ║
 * ║  The gateway handles auth so you don't have to.                    ║
 * ║                                                                    ║
 * ║  Read `.agents/skills/aether/bigquery.md` for the full guide.      ║
 * ╚════════════════════════════════════════════════════════════════════╝
 *
 * All helpers in this file must be called from Nitro server routes
 * (`server/api/**`) — never from `<script setup>` or client-side
 * code. The gateway URL is in the public env so the client could
 * technically call it, but doing so would expose the orgId in
 * browser network logs and bypass any future per-user auth we add.
 */

interface GatewayEnv {
    gatewayUrl: string;
    orgId: string;
    datasetId: string | null;
    projectId: string | null;
    location: string | null;
}

function readGatewayEnv(): GatewayEnv | null {
    const gatewayUrl = process.env.NUXT_PUBLIC_GATEWAY_URL;
    const orgId = process.env.NUXT_PUBLIC_TENANT_ORG_ID;
    if (!gatewayUrl || !orgId) return null;
    return {
        gatewayUrl: gatewayUrl.replace(/\/+$/, ''),
        orgId,
        datasetId: process.env.NUXT_PUBLIC_BIGQUERY_DATASET_ID || null,
        projectId: process.env.NUXT_PUBLIC_BIGQUERY_PROJECT_ID || null,
        location: process.env.NUXT_PUBLIC_BIGQUERY_LOCATION || null,
    };
}

/**
 * Whether BigQuery is provisioned for this tenant. Returns false in
 * local dev (env vars unset) AND in deployed builds where the tenant
 * opted out of BQ at provision time.
 *
 * Pages and routes should call this early and render a "BigQuery is
 * not configured for this app" state instead of throwing.
 */
export function isBigQueryConfigured(): boolean {
    return process.env.NUXT_PUBLIC_BIGQUERY_ENABLED === 'true';
}

/**
 * The default analytics dataset for this tenant, or null if BQ isn't
 * configured. Pass this as `defaultDataset` to `runQuery()` so the
 * agent's SQL can write `FROM events` instead of fully-qualified
 * `FROM \`bc-{slug}.bc_{slug}_analytics.events\``.
 */
export function getDefaultDataset(): string | null {
    return readGatewayEnv()?.datasetId ?? null;
}

export function getBigQueryProjectId(): string | null {
    return readGatewayEnv()?.projectId ?? null;
}

export function getBigQueryLocation(): string | null {
    return readGatewayEnv()?.location ?? null;
}

export interface BqDataset {
    datasetId: string;
    projectId: string;
    location?: string;
    labels?: Record<string, string>;
    friendlyName?: string;
}

export interface BqTableField {
    name: string;
    type: string;
    mode?: string;
    description?: string;
    fields?: BqTableField[];
}

export interface BqTable {
    tableId: string;
    type?: string;
    numRows?: string | null;
    numBytes?: string | null;
    lastModifiedTime?: string | null;
    schema?: { fields: BqTableField[] };
    description?: string;
}

export interface BqQueryResult {
    /** Column definitions, in result order. */
    schema: BqTableField[];
    /**
     * Raw BigQuery v2 rows. Each row is `{ f: [{ v: ... }, ...] }`.
     * Use `toRowObjects()` to convert into `Record<string, unknown>[]`.
     */
    rows: Array<{ f: Array<{ v: unknown }> }>;
    totalRows: string;
    totalBytesProcessed: string;
    cacheHit: boolean;
    jobId: string;
    truncated: boolean;
}

export interface BqQueryParam {
    name: string;
    /** BigQuery type: STRING / INT64 / FLOAT64 / BOOL / DATE / TIMESTAMP / etc. */
    type: string;
    value: unknown;
}

export interface RunQueryOptions {
    /** Default 1000, max 10000. */
    maxResults?: number;
    /** Default 1 GB, max 10 GB. BigQuery rejects queries that would scan more. */
    maxBytesBilled?: number;
    params?: BqQueryParam[];
    /**
     * Default dataset for unqualified table references. Defaults to
     * the tenant's analytics dataset.
     */
    defaultDataset?: string;
}

export interface BqMutationResult {
    jobId: string;
    /**
     * BigQuery's classification of the statement (e.g. `INSERT`,
     * `UPDATE`, `CREATE_TABLE`, `DROP_TABLE`). Useful for the UI to
     * render a precise "Inserted 3 rows" / "Created table" message.
     */
    statementType: string | null;
    /** For DML, number of rows affected. `null` for DDL. */
    numDmlAffectedRows: string | null;
    /** For DML, detailed insert/update/delete counts. `null` for DDL. */
    dmlStats: {
        insertedRowCount?: string;
        updatedRowCount?: string;
        deletedRowCount?: string;
    } | null;
    totalBytesProcessed: string;
    /**
     * True when BigQuery didn't finish the mutation inside the
     * gateway's 60s window. The job is still running server-side;
     * callers should treat this as "in flight" rather than retrying.
     */
    pending: boolean;
}

export interface RunMutationOptions {
    params?: BqQueryParam[];
    /**
     * Default dataset for unqualified table references. Defaults to
     * the tenant's analytics dataset.
     */
    defaultDataset?: string;
    /** Default 1 GB, max 10 GB. */
    maxBytesBilled?: number;
}

function configError(): Error {
    return new Error(
        'BigQuery is not configured for this tenant. Set NUXT_PUBLIC_BIGQUERY_ENABLED + NUXT_PUBLIC_GATEWAY_URL + NUXT_PUBLIC_TENANT_ORG_ID. ' +
            'In local dev these are intentionally unset; deploy or check `isBigQueryConfigured()` before calling BQ helpers.'
    );
}

async function gatewayFetch<T>(
    path: string,
    init?: RequestInit & { method?: string; body?: unknown }
): Promise<T> {
    const env = readGatewayEnv();
    if (!env) throw configError();
    const url = `${env.gatewayUrl}/api/bigquery/${env.orgId}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const res = await fetch(url, {
        method: init?.method || 'GET',
        headers,
        body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            const json = (await res.json()) as { statusMessage?: string; message?: string };
            detail = json.statusMessage || json.message || detail;
        } catch {
            // body wasn't JSON; keep the status-line detail
        }
        throw new Error(`bigquery gateway: ${detail}`);
    }
    return res.json() as Promise<T>;
}

/**
 * List datasets visible in the tenant project. The portal SA has
 * `metadataViewer` project-wide, so this returns every dataset that
 * lives in `bc-{slug}` (including ad-hoc ones the agent or tenant
 * created later — note those won't be readable via `runQuery` until
 * dataset ACLs are added).
 */
export async function listDatasets(): Promise<BqDataset[]> {
    const res = await gatewayFetch<{ project_id: string; datasets: BqDataset[] }>('/datasets');
    return res.datasets;
}

/**
 * List tables in a dataset. When `withSchema` is true (the default)
 * the first 200 tables come back with full schema + row/byte counts;
 * use `false` for very large datasets where the schema fan-out would
 * be slow.
 */
export async function listTables(
    datasetId: string,
    options: { withSchema?: boolean } = {}
): Promise<BqTable[]> {
    const withSchema = options.withSchema !== false ? 'true' : 'false';
    const res = await gatewayFetch<{
        project_id: string;
        dataset_id: string;
        tables: BqTable[];
    }>(`/tables/${encodeURIComponent(datasetId)}?withSchema=${withSchema}`);
    return res.tables;
}

/**
 * Run a read-only SQL query in the tenant project. The gateway
 * refuses DML/DDL — only `SELECT` / `WITH` / `CALL` are allowed. The
 * gateway also caps bytes scanned (default 1 GB, max 10 GB) and rows
 * returned (default 1000, max 10000).
 *
 * Use `toRowObjects()` to convert the result into a `Record[]` for
 * easy serialization back to the client.
 */
export async function runQuery(sql: string, options: RunQueryOptions = {}): Promise<BqQueryResult> {
    const env = readGatewayEnv();
    if (!env) throw configError();
    const defaultDataset = options.defaultDataset ?? env.datasetId ?? undefined;
    const body: Record<string, unknown> = { sql };
    if (options.maxResults !== undefined) body.maxResults = options.maxResults;
    if (options.maxBytesBilled !== undefined) body.maxBytesBilled = options.maxBytesBilled;
    if (options.params && options.params.length > 0) body.params = options.params;
    if (defaultDataset) body.defaultDataset = defaultDataset;
    return gatewayFetch<BqQueryResult>('/query', { method: 'POST', body });
}

/**
 * Run a write SQL statement (DML or DDL) in the tenant project.
 *
 * Accepts: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`,
 * `CREATE TABLE` / `CREATE OR REPLACE TABLE` / `CREATE TABLE IF NOT EXISTS`,
 * `DROP TABLE`, `ALTER TABLE`, `CREATE VIEW`, `DROP VIEW`,
 * `CREATE SCHEMA`, `DROP SCHEMA`.
 *
 * Rejects: `SELECT` / `WITH` (use `runQuery` instead), `CALL`,
 * `GRANT` / `REVOKE`, `EXPORT DATA` / `LOAD DATA`.
 *
 * The gateway runs the mutation against any dataset inside the tenant's
 * GCP project; cross-project references will 403 because the portal
 * service account has no roles outside the tenant project.
 *
 * Mutations cost money and aren't easily undone — surface a confirmation
 * dialog before calling for destructive verbs (`DROP`, `TRUNCATE`,
 * `DELETE` without a `WHERE`).
 *
 * If the response comes back with `pending: true`, the mutation didn't
 * finish inside the 60s sync window but is still running server-side.
 * Don't retry; surface "still running" to the user instead.
 */
export async function runMutation(
    sql: string,
    options: RunMutationOptions = {}
): Promise<BqMutationResult> {
    const env = readGatewayEnv();
    if (!env) throw configError();
    const defaultDataset = options.defaultDataset ?? env.datasetId ?? undefined;
    const body: Record<string, unknown> = { sql };
    if (options.maxBytesBilled !== undefined) body.maxBytesBilled = options.maxBytesBilled;
    if (options.params && options.params.length > 0) body.params = options.params;
    if (defaultDataset) body.defaultDataset = defaultDataset;
    return gatewayFetch<BqMutationResult>('/mutation', { method: 'POST', body });
}

/**
 * Helper to flatten the BigQuery `{ f: [{ v: ... }] }` row format
 * into plain `Record<string, unknown>[]` keyed by column name.
 *
 * BigQuery returns all scalar values as strings (yes, even INT64 and
 * FLOAT64). If you need typed values, parse them yourself — this
 * helper leaves them as-is so the caller controls precision.
 */
export function toRowObjects(result: BqQueryResult): Record<string, unknown>[] {
    return result.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        result.schema.forEach((field, idx) => {
            obj[field.name] = row.f[idx]?.v ?? null;
        });
        return obj;
    });
}
