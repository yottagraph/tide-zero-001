# Aether UI — Kubernetes Reference

This directory documents the Kubernetes resources that run the Aether
UI on the BC 2.0 GCP substrate (per-tenant GKE cluster) — but it does
**not** contain manifests you apply by hand.

The Portal owns the manifest shapes (see
`broadchurch/portal/ui/server/utils/k8s-ui.ts` — landed in ENG-667
sub-issue #4) and renders them at tenant provisioning time. The
tenant repo's `.github/workflows/deploy-ui.yml` only rolls the
Deployment to a new image SHA on subsequent deploys.

> If your tenant has `hosting: vercel` in `broadchurch.yaml`, nothing
> in this directory applies to you. Vercel handles your UI; this
> directory is dormant.

## What the Portal renders (reference)

At BC 2.0 provisioning time (when `hosting: gcp`), the Portal applies
four resources in the per-tenant GKE cluster's `tenant-ui` namespace:

```yaml
---
# 1. Workload Identity binding — K8s SA assumes the tenant-project GCP
# SA `bc-aether-ui@<project>.iam` for Cloud SQL, Secret Manager,
# BigQuery, etc.
apiVersion: v1
kind: ServiceAccount
metadata:
    name: aether-ui
    namespace: tenant-ui
    annotations:
        iam.gke.io/gcp-service-account: bc-aether-ui@<project>.iam.gserviceaccount.com
---
# 2. Deployment — the Nuxt SSR app. Image SHA gets updated by
# deploy-ui.yml on every deploy via `kubectl set image`. All other
# fields are owned by the Portal.
apiVersion: apps/v1
kind: Deployment
metadata:
    name: aether-ui
    namespace: tenant-ui
spec:
    replicas: 1 # Phase 1; HPA is Phase 2+
    selector:
        matchLabels:
            app.kubernetes.io/name: aether-ui
    template:
        metadata:
            labels:
                app.kubernetes.io/name: aether-ui
        spec:
            serviceAccountName: aether-ui
            containers:
                - name: aether-ui
                  image: <region>-docker.pkg.dev/<project>/aether/aether-app:<sha>
                  ports:
                      - name: http
                        containerPort: 3000
                  resources:
                      requests: { cpu: 100m, memory: 256Mi }
                      limits: { cpu: 1000m, memory: 1Gi }
                  readinessProbe:
                      httpGet: { path: /, port: http }
                      initialDelaySeconds: 5
                      periodSeconds: 10
                  livenessProbe:
                      httpGet: { path: /, port: http }
                      initialDelaySeconds: 30
                      periodSeconds: 30
                  envFrom:
                      - secretRef:
                            name:
                                aether-ui-secrets # Portal materializes from
                                # Secret Manager at provision
                  env:
                      # Portal-injected plain-text env (Portal re-renders if any
                      # of these change). Mirror of ENG-695 for the Jobs path —
                      # design contract in BC_2_TENANT_UI_HOSTING_PHASE1.md
                      # §"Env-var contract".
                      - { name: NUXT_PUBLIC_APP_ID, value: '<slug>' }
                      - { name: NUXT_PUBLIC_APP_NAME, value: '<display>' }
                      - { name: NUXT_GATEWAY_URL, value: '<portal-url>' }
                      - {
                            name: NUXT_QUERY_SERVER_URL,
                            value: 'https://query.pip.prod.g.lovelace.ai',
                        }
                      - { name: GOOGLE_CLOUD_PROJECT, value: '<project>' }
                      - { name: ORG_ID, value: '<org_id>' }
---
# 3. Service — internal LB so the per-tenant GKE controller can stand
# up a PSC ServiceAttachment.
apiVersion: v1
kind: Service
metadata:
    name: aether-ui-ilb
    namespace: tenant-ui
    annotations:
        networking.gke.io/load-balancer-type: 'Internal'
spec:
    type: LoadBalancer
    selector:
        app.kubernetes.io/name: aether-ui
    ports:
        - name: http
          port: 80
          targetPort: http
          protocol: TCP
---
# 4. ServiceAttachment — exposes the ILB to the broadchurch project
# via Private Service Connect. The broadchurch-side ALB consumes this
# from the shared VPC. See gcp-bctenant ENG-703 for the PSC NAT subnet.
apiVersion: networking.gke.io/v1
kind: ServiceAttachment
metadata:
    name: aether-ui-sa
    namespace: tenant-ui
spec:
    connectionPreference: ACCEPT_AUTOMATIC
    natSubnets:
        - sb-<slug>-psc-nat
    resourceRef:
        kind: Service
        name: aether-ui-ilb
```

The broadchurch-side ALB plumbing (PSC NEG → backend service → URL
map → HTTPS proxy → wildcard cert → forwarding rule → DNS A record
for `aether-ui.<slug>.tenant.g.lovelace.ai`) lives in the broadchurch
project and is owned by `portal/ui/server/utils/tenant-ui-alb.ts`
(landing in ENG-667 sub-issue #4). Not shown above.

## RBAC

Provisioned by `gcp-bctenant` TF (sub-issue #2): namespace-scoped
Role + RoleBinding `tenant-ui-deployer` granting the
`github-deploy@<project>.iam` SA `get/list/create/update/patch/delete`
on `deployments`, `services`, `secrets`, `configmaps`,
`serviceattachments` in `tenant-ui`. This is what lets `deploy-ui.yml`
call `kubectl set image` over Connect Gateway.

## Secrets

The `aether-ui-secrets` K8s Secret is materialized by the Portal at
provision time from GCP Secret Manager in the per-tenant project.
Phase 1 contents:

| K8s Secret key             | Secret Manager entry         | Source                                                     |
| -------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `NUXT_AUTH0_CLIENT_SECRET` | `aether-auth0-client-secret` | Provisioner writes during Auth0 step                       |
| `NUXT_PORTAL_API_KEY`      | `aether-portal-api-key`      | Provisioner writes during GCP step                         |
| `NUXT_CLOUDSQL_PASSWORD`   | `aether-cloudsql-password`   | Created only if password-auth opt-in (default is IAM auth) |

Re-sync the K8s Secret from Secret Manager via the cockpit's
"Sync Secrets" button (lands in sub-issue #6). The deploy workflow
itself does **not** touch secrets — that's the Portal's job.

## What the deploy workflow actually changes

`deploy-ui.yml` issues exactly one mutation against the cluster:

```bash
kubectl set image deployment/aether-ui aether-ui=<image>:<sha> -n tenant-ui
```

Plus the post-roll `kubectl rollout status` watch. Nothing else. If
you find yourself reaching for `kubectl apply -f` from this directory,
something is wrong — that's the Portal's responsibility.

## See also

- Phase 1 design contract:
  [`broadchurch/docs/BC_2_TENANT_UI_HOSTING_PHASE1.md`](https://github.com/Lovelace-AI/broadchurch/blob/main/docs/BC_2_TENANT_UI_HOSTING_PHASE1.md)
- Substrate ADR:
  [`broadchurch/docs/DECISIONS.md` § ADR-020](https://github.com/Lovelace-AI/broadchurch/blob/main/docs/DECISIONS.md#adr-020-tenant-ui-substrate--gke-deployment-in-per-tenant-cluster)
- Sibling: `jobs/<name>/` (K8s Jobs manifests live in the tenant repo;
  UI manifests live in the Portal — the design intentionally splits
  ownership this way because UI is exactly-one-per-tenant whereas
  jobs are many-per-tenant)
- Deploy command: `commands/deploy_ui.md` (and the post-install
  `.agents/commands/deploy_ui.md` mirror)
