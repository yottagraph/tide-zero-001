# Deploy Aether UI

Deploy the Aether UI to the per-tenant GKE cluster (BC 2.0 GCP
substrate, per [ADR-020](https://github.com/Lovelace-AI/broadchurch/blob/main/docs/DECISIONS.md#adr-020-tenant-ui-substrate--gke-deployment-in-per-tenant-cluster)).

## When to use

This command applies to tenants whose `broadchurch.yaml` has `hosting:
gcp` — i.e. **BC 2.0 tenants that opted into the GCP substrate during
provisioning**.

If your tenant has `hosting: vercel` (or no `hosting:` field at all),
your UI deploys through Vercel automatically on push to `main`. This
command does nothing for you — see the Vercel dashboard linked from
the BC 2.0 cockpit for deploy state.

## What it does

Triggers the tenant repo's `.github/workflows/deploy-ui.yml` workflow.
The workflow:

1. Reads `broadchurch.yaml` and confirms `hosting: gcp`.
2. WIF-authenticates to the per-tenant GCP project.
3. Builds the repo-root `Dockerfile` with Cloud Build, tagging the image
   `<region>-docker.pkg.dev/<project>/aether/aether-app:<sha-7>`.
4. Resolves cluster coordinates from the Portal
   (`GET /api/projects/<org>/connect-gateway`).
5. Configures `kubectl` against Connect Gateway for the tenant's GKE
   cluster.
6. `kubectl set image deployment/aether-ui aether-ui=<image>` in the
   `tenant-ui` namespace, then waits for `kubectl rollout status` (cap
   3 min).
7. POSTs a deploy record to the Portal so the cockpit's UI Substrate
   panel reflects the new SHA.

No K8s resources are **created** by this workflow — the Deployment +
Service + ServiceAttachment + ALB are all owned by the Portal at
provision time. The workflow only rolls the image.

## Prerequisites

- Tenant has `hosting: gcp` in `broadchurch.yaml`.
- Tenant's per-tenant GCP project has been provisioned **with the UI
  substrate enabled** (Portal cockpit "Enable GCP substrate" button, or
  MCP `enable_ui_substrate` once it ships — see Phase 1 sub-issue #4).
  This is what creates the namespace + WI SA + initial Deployment + ALB.
- The repo-root `Dockerfile` exists (it does — shipped from the aether
  template).
- The commit you want to deploy is pushed to `main` (or whatever branch
  you want to roll from — the workflow uses the workflow-run's SHA).

## Step 1: Read configuration

```bash
cat broadchurch.yaml | yq '{hosting, gcp, tenant, gateway}'
```

If `hosting` is `vercel` (or missing), stop — this command isn't for
you.

If `hosting` is `gcp`, note `tenant.org_id` and `gateway.url` for the
manual fallback in Step 3.

## Step 2: Ensure code is pushed

```bash
git status
```

If there are uncommitted changes you want deployed, commit and push
first. The workflow builds from the GitHub SHA, not your local tree.

## Step 3: Trigger the deploy

**Canonical path (once Phase 1 sub-issue #5 lands):**

```bash
curl -sf -X POST "<GATEWAY_URL>/api/projects/<ORG_ID>/deploy" \
  -H "Content-Type: application/json" \
  -d '{"type": "ui"}'
```

**Manual fallback (works today, before #5 ships):**

```bash
gh workflow run deploy-ui.yml
```

(Or click "Run workflow" in the GitHub Actions UI on the Aether UI
workflow.)

## Step 4: Monitor

```bash
gh run watch -R <owner>/<repo>
# or
gh run list -R <owner>/<repo> --workflow deploy-ui.yml --limit 3
```

Typical timeline:

- **0-30s**: workflow queues, checks out the repo, validates substrate.
- **2-3m**: Cloud Build builds the image (heavy on a cold cache; ~1m
  with cache).
- **3-3.5m**: `kubectl set image` and rolling restart.
- **3.5-4m**: deploy record posted to Portal, workflow exits.

Once the workflow succeeds, the new SHA is live at
`https://aether-ui.<slug>.tenant.g.lovelace.ai`. The cockpit's UI
Substrate panel reflects the new image and "Deployed at" time within
~5s.

## Rollback

```bash
# Quickest path — operator-side, no GHA round-trip:
kubectl rollout undo deployment/aether-ui -n tenant-ui

# Or via the cockpit's "Rollback" button (once Phase 1 sub-issue #6
# ships the panel).
```

Connect Gateway kubeconfig setup is the same as the deploy workflow's
step — easiest is to copy `KUBECONFIG=/tmp/kubeconfig` from a recent
GHA run's logs and re-use the token (TTL ~1h).

## Troubleshooting

### "hosting=vercel — Aether UI is not on the GCP substrate"

The workflow exited cleanly because `broadchurch.yaml` says
`hosting: vercel`. To migrate to the GCP substrate, follow
[ENG-665 Phase 3](https://linear.app/lovelace-tech/issue/ENG-665) (not
yet shipped — migration playbook still in design).

### "Repo root Dockerfile is required for the GCP substrate"

The workflow couldn't find `Dockerfile` at the repo root. The
canonical multi-stage Dockerfile shipped from the aether template in
[aether-dev#129](https://github.com/Lovelace-AI/aether-dev/pull/129);
re-run `/update_instructions` or compare against `aether-dev/Dockerfile`.

### "Deployment tenant-ui/aether-ui does not exist"

The Portal hasn't provisioned the UI substrate for this tenant yet.
Run the cockpit's "Enable GCP substrate" button (or, until Phase 1
sub-issue #4 ships that, ask in #broadchurch-platform — operators are
running the provisioning step imperatively).

### Cloud Build fails

Check the Cloud Build log link in the workflow output. Common causes:

- **`prebuild` guard trips on direct `@google-cloud/*` imports**: the
  build still rejects direct SDK calls because Phase 1 hasn't yet
  relaxed the guard for the GCP substrate (the guard's relaxation is
  part of [`skills/aether/data.md`](../skills/aether/data.md) §"Direct
  GCP access for hosting: gcp tenants" — written but not yet released).
  For now, route GCP data calls through the Portal proxy.
- **AR repo missing**: the per-tenant `aether` AR repo is provisioned
  by `gcp-bctenant` Phase 1 prereqs (sub-issue #2). If your tenant
  predates that, the workflow's first build fails with
  `Failed to find the repository`; ping #broadchurch-platform.

### `kubectl rollout status` times out

The new image is failing readiness probes. Check Pod logs:

```bash
kubectl logs -n tenant-ui -l app.kubernetes.io/name=aether-ui --tail=200
kubectl describe pod -n tenant-ui -l app.kubernetes.io/name=aether-ui
```

Most common causes: missing env var (compare against `.env.example`),
crash at startup (Nuxt build artifact mismatch), or
`ImagePullBackOff` (AR repo permissions; rare).

If the rollout is stuck and you want to bail:

```bash
kubectl rollout undo deployment/aether-ui -n tenant-ui
```

## See also

- Phase 1 design contract:
  [`broadchurch/docs/BC_2_TENANT_UI_HOSTING_PHASE1.md`](https://github.com/Lovelace-AI/broadchurch/blob/main/docs/BC_2_TENANT_UI_HOSTING_PHASE1.md)
- Substrate ADR:
  [`broadchurch/docs/DECISIONS.md` § ADR-020](https://github.com/Lovelace-AI/broadchurch/blob/main/docs/DECISIONS.md#adr-020-tenant-ui-substrate--gke-deployment-in-per-tenant-cluster)
- The spike that validated this path:
  [`broadchurch/docs/bc-2-foundation-drafts/ui-hosting-spike-001.md`](https://github.com/Lovelace-AI/broadchurch/blob/main/docs/bc-2-foundation-drafts/ui-hosting-spike-001.md)
- Sibling: `/deploy_job` for the K8s Jobs substrate.
