/**
 * GET /api/aggregates
 *
 * Reads the most recent runs of the `aggregate_signals` compute job from
 * the per-tenant Cloud SQL Postgres and returns the per-category rows
 * grouped by `run_id`.
 *
 * Returns an empty `runs: []` if the table does not exist yet (first
 * page load on a fresh deploy before the job has ever run).
 */
import { getDb, isDbConfigured } from '~/server/utils/neon';

interface AggregateRow {
    run_id: string;
    category: string;
    event_count: number;
    sum_value: number;
    created_at: string;
}

interface RunSummary {
    run_id: string;
    created_at: string;
    total_event_count: number;
    total_sum_value: number;
    rows: Array<{
        category: string;
        event_count: number;
        sum_value: number;
    }>;
}

interface ApiResponse {
    configured: boolean;
    runs: RunSummary[];
}

const MAX_RUNS = 10;

export default defineEventHandler(async (): Promise<ApiResponse> => {
    if (!isDbConfigured()) {
        return { configured: false, runs: [] };
    }

    const sql = getDb();
    if (!sql) {
        return { configured: false, runs: [] };
    }

    let rows: AggregateRow[];
    try {
        rows = (await sql`
            WITH recent_runs AS (
                SELECT run_id, MAX(created_at) AS created_at
                FROM tide_aggregates
                GROUP BY run_id
                ORDER BY MAX(created_at) DESC
                LIMIT ${MAX_RUNS}
            )
            SELECT a.run_id,
                   a.category,
                   a.event_count,
                   a.sum_value,
                   a.created_at
            FROM tide_aggregates a
            JOIN recent_runs r ON r.run_id = a.run_id
            ORDER BY r.created_at DESC, a.category ASC
        `) as unknown as AggregateRow[];
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Handle missing-table case per the storage skill: first page load
        // before the job has ever run should not 500.
        if (/relation .*tide_aggregates.* does not exist/i.test(msg) || /42P01/.test(msg)) {
            return { configured: true, runs: [] };
        }
        throw createError({
            statusCode: 500,
            statusMessage: `Failed to read tide_aggregates: ${msg}`,
        });
    }

    const grouped = new Map<string, RunSummary>();
    for (const r of rows) {
        const eventCount = Number(r.event_count) || 0;
        const sumValue = Number(r.sum_value) || 0;
        let summary = grouped.get(r.run_id);
        if (!summary) {
            summary = {
                run_id: r.run_id,
                created_at:
                    r.created_at instanceof Date
                        ? r.created_at.toISOString()
                        : String(r.created_at),
                total_event_count: 0,
                total_sum_value: 0,
                rows: [],
            };
            grouped.set(r.run_id, summary);
        }
        summary.total_event_count += eventCount;
        summary.total_sum_value += sumValue;
        summary.rows.push({
            category: r.category,
            event_count: eventCount,
            sum_value: sumValue,
        });
    }

    const runs = Array.from(grouped.values()).sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
    );

    return { configured: true, runs };
});
