# Tide Zero #001 — Fresh-tenant compute-job e2e

## Vision

# Tide Telemetry — Cloud SQL Compute-Job E2E

A small Aether app that proves the BC 2.0 **compute-job → Cloud SQL**
round-trip works end-to-end from a fresh tenant. One compute job
generates synthetic maritime activity events, aggregates them by
category, and writes the per-category summary rows into the tenant
Cloud SQL Postgres. One page in the app reads those rows back and
shows them.

This project exists to test the compute infrastructure from a coding
agent's perspective. The success criterion is **"the job deploys via
`/deploy_job`, runs end-to-end, and the rows it wrote show up both in
Cloud SQL and on the page."** Resist over-engineering — there's no
business problem hiding here.

## Deliverables

### 1. Compute job (`jobs/aggregate_signals/`)

A Python compute job that:

1. **Synthesises ~1000 events** deterministically from a per-run
   `SMOKE_RUN_ID` (UUID; generate if not supplied). Each event has
   a `category` (pick from a small fixed set like
   `vessel,event,entity,signal,observation`) and a numeric `value`
   in `[0, 100)`. Same `run_id` → same input → same aggregates;
   re-runs append, they do not overwrite.
2. **Aggregates** to `(category, event_count, sum_value)` per category.
3. **Writes one row per category** to a `tide_aggregates` table in
   the per-tenant Cloud SQL Postgres, tagged with `run_id` and a
   `created_at` timestamp. Use `CREATE TABLE IF NOT EXISTS` — there
   is no migrations framework.
4. **Reads the rows back** in the same execution and logs them, plus
   a final `JOB_SUCCESS run_id=… rows_inserted=… total_events=…`
   sentinel line so log scrapers (and humans) can confirm the run
   landed.
5. Exits 0 on success, 1 on any failure (missing GRANTs, schema
   mismatch, total-events drift, anything).

Manifest (`jobs/aggregate_signals/job.yaml`): pick cpu / memory /
task_timeout that suit a ~1000-row synthesis (a 1 vCPU / 1 GiB / 10m
budget is plenty). Read the `compute` Aether skill before you write
the manifest — it explains the K8s Jobs runner (sole supported runner
per ADR-019), the standard env that's auto-injected, the
`${secret://name/version}` syntax for anything sensitive, and the
validator you should run locally before pushing
(`python3 scripts/validate-job-manifest.py jobs/aggregate_signals/job.yaml`).
You do NOT need to set a `runner:` field — it defaults to `k8s_job`.

The schedule field is **off** for this project — the test path is
"Run now from the Portal", not "wait for cron". Adding `schedule:` is
a nice-to-have but not required.

### 2. Reader page (`pages/index.vue`)

A single page that shows the most recent runs and their per-category
aggregates. Minimal Vuetify is fine:

- One **"Latest run" card** at the top showing `run_id`,
  `created_at`, total `event_count`, and total `sum_value`.
- One **data table** below it with the per-category rows of the
  latest run (`category`, `event_count`, `sum_value`).
- A history strip showing the last ~10 runs so you can tell at a
  glance that re-running the job adds new rows rather than
  clobbering old ones.

Group by `run_id` and order by `created_at DESC`. If there are zero
rows yet (job hasn't run), show a friendly "No runs yet — trigger
the `aggregate_signals` job from the Portal's Jobs tab" state
instead of a blank table.

### 3. Server route (`server/api/aggregates.get.ts`)

A Nitro GET route that returns the JSON the page binds to. Reads
from Cloud SQL via the standard `getDb()` helper in
`server/utils/neon.ts` (the same helper Aether uses for the
IAM-auth Cloud SQL connection — see `skills/aether/storage.md` for
the connection wiring on the Vercel app side). Return shape is your
call; keep it boring.

Handle the "table doesn't exist yet" case per
`skills/aether/storage.md` § _Handle missing tables in GET routes_ —
the first page load on a fresh deploy will hit it before the job
has ever run, and you should return an empty state, not a 500.

## Acceptance criteria

Do all four of these and report back; that's the end of the project:

1. `/deploy_job aggregate_signals` succeeds — the GitHub Actions
   workflow goes green and the Portal's Jobs tab shows the new job.
2. An ad-hoc run (`POST <GATEWAY_URL>/api/projects/<ORG_ID>/jobs/aggregate-signals/run`,
   or the Portal's "Run now" button) completes with status
   `Succeeded`.
3. Querying the tenant Cloud SQL returns the expected rows for that
   run — one per category, `event_count` summing to the synthesised
   total. Use whatever tool the platform makes available; the
   `broadchurch-platform` MCP server's read helpers, an in-cluster
   psql via Connect Gateway, the deployed app's `/api/aggregates`
   endpoint, or `kubectl -n tenant-jobs logs` of the completed job
   pod (which logs the same rows it just wrote) all qualify.
4. The deployed app's home page renders those rows. Push to `main`,
   wait for the Vercel deploy, hit the URL.

## Tech notes

- **This is a compute-infra test, not a product.** Don't add auth,
  branding, analytics, charts, dark mode, or any feature not listed
  above. Resist scope creep — the goal is to prove the substrate
  works, not to ship a real app.
- **Read the `compute` skill first.** `.agents/skills/aether/compute.md`
  is the canonical guide. It covers `job.yaml` shape, the K8s Jobs
  runtime model, the standard env vars compute jobs receive
  (including `INSTANCE_CONNECTION_NAME`, `DB_USER`, `DB_NAME` which
  the deploy workflow auto-injects when Cloud SQL is enabled), the
  `${secret://name/version}` syntax for anything sensitive, the
  validator, and where every component (container image, K8s Job
  in `tenant-jobs`, Portal registration) lives. Pair it with
  `compute.md`'s _Cloud SQL vs BigQuery — where to write_ section
  to confirm Cloud SQL is the right target here (it is — this is
  exactly the "job updates a few rows the UI then reads" pattern).
- **`/deploy_job` is the supported path.** Don't hand-roll a
  `kubectl apply`, don't push container images by hand, don't build
  a Dockerfile by hand (the deploy workflow auto-generates one if
  missing). If `/deploy_job` doesn't work, **stop and report** —
  that's a platform finding worth surfacing rather than working
  around.
- **The job and the Vercel app talk to Cloud SQL differently.** The
  Vercel app uses the `getDb()` helper in `server/utils/neon.ts`
  (IAM auth on the runtime SA — see `skills/aether/storage.md`).
  The compute job connects with `google-cloud-sql-python-connector`
  + IAM auth using the `bc-tenant-jobs` GSA via Workload Identity,
  with `INSTANCE_CONNECTION_NAME`, `DB_USER`, and `DB_NAME` injected
  by the deploy workflow. Both routes write to the same physical
  Postgres. See `compute.md`'s _Quick start: a Cloud SQL aggregation
  job_ for the canonical pattern — it's copy-pasteable for this
  project's job almost as-is. If those env vars are missing at job
  runtime, log a clear error and report it (that's a platform
  finding worth surfacing).
- **Cloud SQL warm-up takes 5-15 min.** The tenant is provisioned
  with `cloud_sql: true`, so the async worker is queued. Before you
  can deploy the job, the warm-up has to finish — watch the Portal
  cockpit / `get_infra_status` until the Cloud SQL row is `ready`.
  The deploy workflow's standard-env step queries
  `gcloud sql instances list` at deploy time and will silently skip
  the SQL coords if the instance doesn't exist yet, which means a
  job deployed before warm-up will exit 1 at runtime with
  `KeyError: 'INSTANCE_CONNECTION_NAME'`. Don't deploy until the
  cockpit shows ready.
- **Verification path matters.** Don't trust the Portal job-run
  status alone — read the Cloud SQL rows back. The point of the
  test is to prove the data plane works end-to-end, not just that
  the container exited 0.
- **You do NOT need to validate the UI behavior by running your own
  UI and gathering screenshots.** A one-shot `curl` against the
  deployed `/api/aggregates` endpoint (after pushing to `main` and
  waiting for the Vercel deploy) is enough to prove the read path
  works.
- **Auth can use the default dev bypass** (`NUXT_PUBLIC_USER_NAME`).
  No real users will see this app.

## Feedback we want back

When you're done — or stuck — report on:

1. **Did the documented path actually work?** Which steps in the
   `compute` skill, `/deploy_job` command, and `storage` skill held
   up; which ones drifted from reality; which ones were missing
   something you had to figure out yourself.
2. **Where did the platform make you wait or guess?** Cloud SQL
   warm-up, env-var propagation, Vercel deploy lag, anything where
   the right "is it ready?" signal wasn't obvious.
3. **What would have made this 10x easier?** A scaffold command,
   a more explicit standard env, a worked Cloud-SQL-from-a-job
   example in the skill, a different validator output — anything
   concrete.

That feedback is the actual product of this project; the running
job is just the evidence the substrate works.


## Status

End-to-end run on **2026-05-28** by the Cursor cloud agent.

Acceptance criteria:

1. ✅ `/deploy_job aggregate_signals` — workflow run
   [26578775966](https://github.com/yottagraph/tide-zero-001/actions/runs/26578775966)
   went green in 2m04s. The job appears in the Portal's Jobs tab.
2. ✅ Job execution — the deploy workflow's "Create K8s Job
   (k8s_job, immediate)" step submits the Job and waits for terminal
   status. `bc-job-aggregate-signals-5656c8df` reached `Succeeded` in
   15 s. Pod log emits `JOB_SUCCESS run_id=8d566447-942a-41d4-90b5-6e8d5e9e9c6a
   rows_inserted=5 total_events=1000`. **An explicit POST to
   `/api/projects/<ORG_ID>/jobs/aggregate-signals/run` was NOT needed**
   because the deploy step itself doubles as the first invocation.
3. ✅ Rows in Cloud SQL — verified two ways. The pod's own read-back
   dump (in the deploy log) shows all five `(category, event_count,
   sum_value, created_at)` tuples it just wrote. Categories sum to
   `total_events=1000` exactly. Cloud SQL coords:
   `bc-tide-zero-001-48ja:us-central1:bc-tide-zero-001-pg-d1a3`, DB
   `bctenant`, user `bc-tenant-jobs@bc-tide-zero-001-48ja.iam` (IAM
   auth via the Python Connector, no password).
4. ⚠️ Vercel home-page render — **blocked by a platform gap**. The
   deployed app renders the empty/warning state (graceful fallback)
   because `DATABASE_URL` is not injected on the Vercel project.
   `curl https://tide-zero-001.yottagraph.app/api/aggregates` returns
   `{"configured":false,"runs":[]}`. See the Findings section below
   for the root cause and recommended fix.

## Findings (feedback for the platform team)

### What worked

- **`compute.md` "Quick start: a Cloud SQL aggregation job"** is
  excellent and copy-pasteable. The `cloud-sql-python-connector` +
  `pg8000` + IAM-auth pattern worked first try with zero local GCP
  credentials. `INSTANCE_CONNECTION_NAME` / `DB_USER` / `DB_NAME` were
  injected as documented (ENG-695).
- **`scripts/validate-job-manifest.py`** is fast, dependency-free, and
  produces a normalized JSON the workflow consumes — caught nothing on
  this manifest because the manifest was small, but the round-trip
  added zero deploy lag and ran locally in <300 ms.
- **`/deploy_job` flow** — `POST <GATEWAY_URL>/api/projects/<ORG_ID>/deploy`
  with `{"type":"job","name":"…"}` returned a clean monitor URL.
  `gh run view --log` showed the K8s Job created, scheduled to the
  `e2-highmem-16` nodepool, image pulled in 4 s, container ran in 2 s,
  and the workflow polled to terminal status. Total deploy-to-rows in
  Cloud SQL: ~2 minutes.
- **The deploy step doubles as the first run.** Step 13 (`Create K8s
  Job (k8s_job, immediate)`) `kubectl apply`s the Job, then polls for
  Succeeded/Failed, then dumps the last 100 pod log lines (including
  the `JOB_SUCCESS` sentinel). This is a huge UX win — one workflow,
  one click, ground truth in the log. Don't change it.

### Where the platform made us guess / hit a wall

1. **Vercel can't reach Cloud SQL on BC 2.0.** This is the biggest
   gap. `skills/aether/storage.md` documents `getDb()` /
   `@neondatabase/serverless` as the single "Postgres" path, but
   that's a Neon-specific HTTP wire protocol that can't talk to a
   Cloud SQL instance sitting behind Private Service Connect with IAM
   auth. There are two sub-issues:
   - **No `DATABASE_URL` is injected** on the Vercel project even
     though the tenant record reports `capabilities.cloud_sql=true`
     and the compute job connects fine. The portal tenant record has
     no `vercel.postgres_store_id` (the field the skill says proves
     provisioning); the Cloud SQL integration with Vercel doesn't
     appear to exist for BC 2.0.
   - **Even if `DATABASE_URL` were set, the `@neondatabase/serverless`
     driver wouldn't work** against Cloud SQL. The proper Vercel-side
     pattern for BC 2.0 Cloud SQL is probably the Cloud SQL Node
     connector with IAM auth via Workload Identity Federation +
     OIDC — but no skill documents this and `server/utils/neon.ts`
     isn't shaped for it.

   **Recommendation:** add a dedicated `cloudsql.md` skill (or a
   "BC 2.0 Cloud SQL from Vercel" section in `storage.md`) describing
   the actual access pattern, and update `init-project.js`'s
   `scaffoldNeonPostgres()` to scaffold the right helper based on
   tenant capabilities. Until then, the documented "push to main →
   page renders rows" loop cannot close for Cloud-SQL-only BC 2.0
   tenants like this one.

2. **`POST /api/projects/<ORG_ID>/jobs/<NAME>/run` still uses the
   Cloud Run code path.** Calling the documented "Run now" endpoint
   returned `403 … Cloud Run Admin API has not been used in project
   bc-tide-zero-001-48ja …`. ADR-019 moved the runner to K8s Jobs
   and the deploy path works, but the run endpoint hasn't been
   migrated. Easy to miss because the deploy step also runs the job
   once, so a happy-path agent never notices — but anyone who follows
   `deploy_job.md` Step 7 ("Trigger a Test Run") literally hits this.

3. **The Portal's data-plane status surface is hard to query
   programmatically.** `GET /api/tenants/<ORG_ID>` returns
   `capabilities.cloud_sql=true` but no Cloud SQL connection coords,
   no `vercel.postgres_store_id`, no warm-up timestamp. The "is Cloud
   SQL ready?" answer the brief tells the agent to wait for isn't a
   single field anywhere. Several other endpoints
   (`/api/projects/<ORG_ID>/jobs`, `/api/projects/<ORG_ID>/jobs/<NAME>/runs`)
   return `403 Forbidden` with no hint about which credential header
   to send.

4. **`.agents/commands/` and `.agents/skills/` weren't present in the
   workspace.** The Cursor session opened with an empty `.agents/`
   (just `Dockerfile`, `environment.json`, `README`). All the skill
   docs and slash-command bodies live in
   `@yottagraph-app/aether-instructions` which `init-project.js`
   *would* extract — but that only runs on `npm run init` /
   `predev`, not on a fresh cloud-agent session that goes straight to
   building. I had to `npm pack` the package into `/tmp` to read
   `deploy_job.md` and `storage.md`. Either ship the extracted skills
   in the template, or have the cloud-agent environment script run
   `/update_instructions` (or the equivalent) at session start.

5. **`@neondatabase/serverless` doesn't ship in the template**, even
   though every "/api/* uses getDb()" example in the storage skill
   needs it. `scaffoldNeonPostgres()` in `init-project.js` installs
   it on demand but only when `DATABASE_URL` shows up in `.env`,
   which it never does in a fresh cloud-agent session. Adding it to
   `dependencies` (or to a more aggressive scaffold path) would
   eliminate the implicit dep.

### What would have made this 10× easier

- A **one-shot scaffold** like `/scaffold_aggregation_job aggregate_signals`
  that drops `jobs/aggregate_signals/{main.py,job.yaml,requirements.txt,
  __init__.py}` with the Cloud-SQL-aggregation skeleton already wired
  to a per-tenant `tide_aggregates` table. The compute skill has the
  pattern; codifying it as a generator would have saved ~30 minutes.
- A **`server/api/aggregates.get.ts` companion scaffold** that pairs
  with the job (same table name, same shape), plus a placeholder
  `pages/index.vue` that reads `/api/aggregates`. This whole project
  is "compute job writes table, page reads table" — the substrate
  test wants a turn-key version of that.
- A **clear "BC 2.0 Cloud SQL from Vercel" section** in `storage.md`
  (see Finding #1) — or an explicit "the Vercel app cannot reach
  Cloud SQL on BC 2.0, verify rows via the deploy log / `psql` /
  MCP read helpers instead" note, so agents don't waste time looking
  for an env var that doesn't exist.
- A **`get_infra_status` MCP tool** (or `GET /api/tenants/<ORG_ID>/data-plane`
  Portal endpoint) returning a single JSON object with the warm-up
  state of each capability and the connection coords once ready. The
  brief told us to wait for "all four data-plane rows are ready" —
  great, but there's no documented API to read that without screen-
  scraping the cockpit.

## Modules

| Module | Path | Purpose |
| --- | --- | --- |
| `aggregate_signals` job | `jobs/aggregate_signals/` | Synthesises ~1000 deterministic events from `SMOKE_RUN_ID`, aggregates to one row per category, writes to Cloud SQL `tide_aggregates`, reads back + logs `JOB_SUCCESS`. |
| `getDb()` helper | `server/utils/neon.ts` | Lazy `@neondatabase/serverless` client off `DATABASE_URL`. Returns `null` when missing (see Finding #1 — currently always `null` for BC 2.0 Cloud SQL tenants). |
| `/api/aggregates` | `server/api/aggregates.get.ts` | Reads last ~10 runs grouped by `run_id`. Handles missing-table (`42P01`) as empty state per the storage skill. |
| Home page | `pages/index.vue` | Latest-run stat card, per-category data table, history strip. Renders friendly empty/warning state when the DB isn't configured. |
