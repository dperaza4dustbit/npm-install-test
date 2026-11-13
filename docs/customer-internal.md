# Customer internal notes: Lightwell validated npm (JavaScript)

Internal / engineering notes for the TP dual-registry harness. For the docs-writer insertion brief, see [`customer-external-recommendations.md`](customer-external-recommendations.md). Historical Pulp packument gap notes: [`pulp-npm-packument-requirement.md`](pulp-npm-packument-requirement.md) (workaround removed after the Pulp fix).

**Customer TP docs** should say an npm-capable **artifact manager** is required for dual-registry prefer, and document **Nexus only** as the verified reference (see [`customer-external-recommendations.md`](customer-external-recommendations.md)). Do **not** push the custom Node proxy as a customer path, and do not interleave Artifactory + Nexus terminology in the same procedure. Artifactory OSS has no npm package type (lab smoke on `artifactory-oss:7.104.12`). Nexus Community (`sonatype/nexus3`) is the harness default: `npm-lightwell` + `npm-npmjs` in `npm-group` (Lightwell first) matches Lightwell on overlap; npmjs-only versions still appear.

## Tech preview status

Lightwell Network JavaScript **Validated** is a **technology preview**.

- Not recommended for production workloads.
- Catalog coverage and registry metadata are still evolving.
- Customer TP pattern: artifact manager with Lightwell before upstream (packument merge, Lightwell wins on overlap; tarball resolve Lightwell then upstream). Customer docs: Nexus as verified reference.
- This harness defaults to **Nexus** (`PROXY_IMPL=nexus`) and keeps a **lab-only** custom Node proxy (`PROXY_IMPL=custom`) for comparison—not for TP customer exposure.

Customer-facing repository URL (same pattern as Java / Python docs):

| Ecosystem | Validated URL |
|---|---|
| Python | `https://packages.redhat.com/lightwell/python/validated` (+ `/simple` for pip) |
| Java | `https://packages.redhat.com/lightwell/java/validated/` |
| JavaScript | `https://packages.redhat.com/lightwell/javascript/validated` |

Do **not** publish the `/api/pulp-content/...` content-app path in customer docs.

## Authentication

### Registry access (same as Java / Python)

Registry Service Account from [Registry Service Accounts](https://access.redhat.com/terms-based-registry/):

| Field | Value |
|---|---|
| Username | Full string: `XXXXXXX\|service-account-name` |
| Password / token | Token on the service account detail page |

Sent as HTTP Basic to `packages.redhat.com` (same as Maven `<server>`, Nexus remote auth, pip `.netrc`).

```bash
export SERVICE_ACCOUNT_USERNAME='XXXXXXX|service-account-name'
export SERVICE_ACCOUNT_PASSWORD='...'   # the registry token
```

When using the dual-registry manager harness, credentials stay on the manager. Client `.npmrc` must **not** hold these credentials.

### Not the same: Lightwell Network API access

Hybrid Cloud Console service account (`CLIENT_ID` / `CLIENT_SECRET`) → short-lived Bearer token for `console.redhat.com` APIs. Different credential set; do not mix with npm Basic auth.

## Recommended TP topology

```text
npm / yarn / pnpm
        │
        ▼
  org artifact manager (Nexus verified here; Artifactory etc. via vendor docs)
        │
        ├─ prefer → https://packages.redhat.com/lightwell/javascript/validated
        └─ else   → customer upstream or https://registry.npmjs.org
```

Why a manager (required for npm dual-target):

1. Prefer Lightwell validated tarballs when present.
2. Fall back to upstream for the rest of the graph.
3. Keep SA credentials off developer laptops / CI job `.npmrc` files.

### Client `.npmrc` (manager)

```ini
registry=http://127.0.0.1:8081/repository/npm-group/
```

### Harness registry manager (this repo)

`./scripts/run.sh` defaults to **Nexus** (`PROXY_IMPL=nexus`, image `sonatype/nexus3`). After boot, [`../scripts/nexus-configure.sh`](../scripts/nexus-configure.sh) creates:

| Repo | Type | Role |
|---|---|---|
| `npm-lightwell` | npm proxy | Lightwell URL + SA Basic |
| `npm-npmjs` | npm proxy | `registry.npmjs.org` |
| `npm-group` | npm group | members: Lightwell, then npmjs |

| Manager | Prefer behavior |
|---|---|
| **Nexus group** (harness default; customer reference) | Member order: Lightwell first. Same-version packument/tarball match Lightwell; npmjs-only versions still appear. |
| **Custom Node proxy** (`PROXY_IMPL=custom`) | Lab-only comparison: Lightwell first; **404** → upstream; packument merge **overwrites** same versions with Lightwell. **Not for TP customer docs.** |

```bash
./scripts/build.sh
export SERVICE_ACCOUNT_USERNAME='XXXXXXX|service-account-name'
export SERVICE_ACCOUNT_PASSWORD='...'
./scripts/run.sh proxy
# PROXY_IMPL=custom  → lab-only Node proxy
```

| Variable | Role |
|---|---|
| `SERVICE_ACCOUNT_USERNAME` / `SERVICE_ACCOUNT_PASSWORD` | Registry SA → Lightwell Basic auth |
| `LIGHTWELL_REGISTRY_URL` | Default pulp-content path until vanity URL is routed |
| `UPSTREAM_REGISTRY_URL` | Second remote / miss fallback (default `https://registry.npmjs.org`) |
| `PROXY_IMPL` | `nexus` (default) or `custom` |
| `NEXUS_FRESH` | `1` to wipe Nexus data volume before start |
| `NEXUS_PLATFORM` | defaults to `linux/amd64` (same as the test image); set `native` for host arch |
| `NEXUS_PUBLISH_HOST_PORT` | `1` (or `MODE=proxy`) to publish Nexus UI on the host; default off for test runs |

Do not expose the manager on the public internet.

## How this repo validates the story

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
./scripts/build.sh
./scripts/run.sh all
```
