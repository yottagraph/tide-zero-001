<template>
    <div class="tide-page">
        <div class="tide-container">
            <header class="tide-header">
                <h1 class="tide-title">{{ appName || 'Tide Telemetry' }}</h1>
                <p class="tide-subtitle">
                    Per-category aggregates written by the
                    <code>aggregate_signals</code> compute job and read back from Cloud SQL.
                </p>
                <div class="tide-actions">
                    <v-btn
                        size="small"
                        variant="tonal"
                        :loading="pending"
                        prepend-icon="mdi-refresh"
                        @click="refresh"
                    >
                        Refresh
                    </v-btn>
                </div>
            </header>

            <v-alert v-if="error" type="error" variant="tonal" class="tide-alert">
                Failed to load aggregates:
                {{ error?.message || String(error) }}
            </v-alert>

            <v-alert
                v-else-if="data && !data.configured"
                type="warning"
                variant="tonal"
                class="tide-alert"
            >
                Cloud SQL is not configured for this deployment (<code>DATABASE_URL</code> missing).
                Provision the per-tenant Postgres via the Portal and redeploy.
            </v-alert>

            <v-alert
                v-else-if="data && data.runs.length === 0"
                type="info"
                variant="tonal"
                class="tide-alert"
            >
                No runs yet — trigger the <code>aggregate_signals</code> job from the Portal's Jobs
                tab.
            </v-alert>

            <template v-else-if="latestRun">
                <v-card class="tide-card tide-latest">
                    <div class="tide-card-eyebrow">Latest run</div>
                    <div class="tide-latest-grid">
                        <div class="tide-stat">
                            <div class="tide-stat-label">run_id</div>
                            <div class="tide-stat-value tide-mono">
                                {{ latestRun.run_id }}
                            </div>
                        </div>
                        <div class="tide-stat">
                            <div class="tide-stat-label">created_at</div>
                            <div class="tide-stat-value tide-mono">
                                {{ formatTs(latestRun.created_at) }}
                            </div>
                        </div>
                        <div class="tide-stat">
                            <div class="tide-stat-label">total event_count</div>
                            <div class="tide-stat-value">
                                {{ latestRun.total_event_count.toLocaleString() }}
                            </div>
                        </div>
                        <div class="tide-stat">
                            <div class="tide-stat-label">total sum_value</div>
                            <div class="tide-stat-value">
                                {{ formatNumber(latestRun.total_sum_value) }}
                            </div>
                        </div>
                    </div>
                </v-card>

                <v-card class="tide-card">
                    <div class="tide-card-eyebrow">Latest run — per-category rows</div>
                    <v-table density="comfortable" class="tide-table">
                        <thead>
                            <tr>
                                <th>category</th>
                                <th class="text-right">event_count</th>
                                <th class="text-right">sum_value</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in latestRun.rows" :key="row.category">
                                <td class="tide-mono">{{ row.category }}</td>
                                <td class="text-right">
                                    {{ row.event_count.toLocaleString() }}
                                </td>
                                <td class="text-right">
                                    {{ formatNumber(row.sum_value) }}
                                </td>
                            </tr>
                        </tbody>
                    </v-table>
                </v-card>

                <v-card v-if="historyRuns.length" class="tide-card">
                    <div class="tide-card-eyebrow">
                        History — last {{ data!.runs.length }} run<span
                            v-if="data!.runs.length !== 1"
                            >s</span
                        >
                    </div>
                    <v-table density="compact" class="tide-table">
                        <thead>
                            <tr>
                                <th>run_id</th>
                                <th>created_at</th>
                                <th class="text-right">events</th>
                                <th class="text-right">sum_value</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="run in data!.runs" :key="run.run_id">
                                <td class="tide-mono tide-runid">
                                    {{ run.run_id }}
                                </td>
                                <td class="tide-mono">
                                    {{ formatTs(run.created_at) }}
                                </td>
                                <td class="text-right">
                                    {{ run.total_event_count.toLocaleString() }}
                                </td>
                                <td class="text-right">
                                    {{ formatNumber(run.total_sum_value) }}
                                </td>
                            </tr>
                        </tbody>
                    </v-table>
                </v-card>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
    interface RunSummary {
        run_id: string;
        created_at: string;
        total_event_count: number;
        total_sum_value: number;
        rows: Array<{ category: string; event_count: number; sum_value: number }>;
    }
    interface ApiResponse {
        configured: boolean;
        runs: RunSummary[];
    }

    const { appName } = useAppInfo();

    const { data, pending, error, refresh } = await useFetch<ApiResponse>('/api/aggregates', {
        server: false,
        default: () => ({ configured: true, runs: [] }),
    });

    const latestRun = computed<RunSummary | null>(() => {
        const runs = data.value?.runs ?? [];
        return runs[0] ?? null;
    });
    const historyRuns = computed<RunSummary[]>(() => data.value?.runs ?? []);

    function formatTs(iso: string): string {
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            return d
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, 'Z');
        } catch {
            return iso;
        }
    }

    function formatNumber(n: number): string {
        if (!Number.isFinite(n)) return String(n);
        return n.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
        });
    }
</script>

<style scoped>
    .tide-page {
        height: 100%;
        overflow-y: auto;
        padding: 32px 24px 64px;
        display: flex;
        justify-content: center;
    }

    .tide-container {
        max-width: 960px;
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 20px;
    }

    .tide-header {
        margin-bottom: 4px;
    }

    .tide-title {
        font-family: var(--font-headline, inherit);
        font-weight: 400;
        font-size: 1.75rem;
        letter-spacing: 0.02em;
        margin-bottom: 6px;
    }

    .tide-subtitle {
        color: var(--lv-silver, #9aa0a6);
        font-size: 0.95rem;
        margin-bottom: 12px;
    }

    .tide-actions {
        display: flex;
        gap: 8px;
    }

    .tide-alert {
        margin-top: 8px;
    }

    .tide-card {
        padding: 18px 20px 12px;
    }

    .tide-card-eyebrow {
        font-family: var(--font-headline, inherit);
        font-size: 0.75rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--lv-silver, #9aa0a6);
        margin-bottom: 12px;
    }

    .tide-latest-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
    }

    .tide-stat-label {
        font-size: 0.75rem;
        color: var(--lv-silver, #9aa0a6);
        letter-spacing: 0.04em;
        text-transform: uppercase;
        margin-bottom: 4px;
    }

    .tide-stat-value {
        font-size: 1rem;
        font-weight: 500;
        word-break: break-all;
    }

    .tide-mono {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.875rem;
    }

    .tide-runid {
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tide-table :deep(th) {
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--lv-silver, #9aa0a6);
    }

    code {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.85em;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.06);
    }
</style>
