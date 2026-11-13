# npm-install-test

Customer-style harness for Red Hat Lightwell **validated** npm packages.

`./scripts/run.sh` starts two containers:

1. **Registry manager** — **Nexus Repository Community** by default (`sonatype/nexus3`): npm proxies for Lightwell + upstream, grouped with Lightwell first. Optional `PROXY_IMPL=custom` for a lab-only prefer-Lightwell Node proxy (compare only; not for customer docs). TP customer docs: artifact manager required for npm dual-target; Nexus as verified reference — see `docs/customer-external-recommendations.md`.
2. **npm-install-test** — installs the frozen inventory through that manager, runs functional smokes, loads `@lightwell/*` natives, verifies SBOM + cosign attestations

Pulp credentials stay on the manager only. The test image has no Lightwell SA.

Customer docs brief: [`docs/customer-external-recommendations.md`](docs/customer-external-recommendations.md). Internal TP / proxy notes: [`docs/customer-internal.md`](docs/customer-internal.md). Historical Pulp packument notes (workaround removed): [`docs/pulp-npm-packument-requirement.md`](docs/pulp-npm-packument-requirement.md).

## What it covers

| Gate | What |
|------|------|
| **functional** | 5 smokes × every frozen **parent** package/version. Tier B/C also assert `@lightwell/*` pull/load |
| **binaries** | Focused Tier B/C re-check: load/run `@lightwell/*` |
| **install** | One tree with npm aliases for all parent versions via the proxy; summarizes upstream misses |
| **provenance** | SBOM hard-fail (SPDX + npm identity) + Quay DSSE attestation (cosign verify + subject digest match) |
| **packuments** | Lightwell packument `versions[]` via the proxy (no install): reject stubs; deps + integrity must match the `.tgz` |

Frozen inventory: [`inventory/packages.json`](inventory/packages.json).

## Credentials

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
# Or: SA_ENV_FILE=/path/to/sa.env ./scripts/run.sh all
```

Injected into the **manager** only (Nexus Lightwell proxy Basic auth, or the custom proxy).

## Build and run

```bash
./scripts/build.sh
./scripts/run.sh all
```

Other modes: `functional` | `binaries` | `install` | `provenance` | `packuments` | `proxy` (manager only, foreground).

```bash
ONLY_PACKAGE=cors@2.8.6 ./scripts/run.sh functional
ONLY_PACKAGE=debug@2.6.9 ./scripts/run.sh packuments
PROXY_IMPL=custom ./scripts/run.sh functional   # lab-only Node proxy
```

`packuments` does not install packages. It GETs the Lightwell **packument** (`GET /name` → `versions[version]` — what npm install uses) and fails if that entry is a stub or its deps / `dist.integrity` disagree with the Lightwell `.tgz`. It does **not** trust `GET /name/version` (Pulp can serve a full version doc there while packument entries are still stubs). Platform packages are skipped. Set `PACKUMENT_COMPARE_NPMJS=1` for an optional secondary compare to community npmjs.

Optional env:

| Variable | Default | Where |
|----------|---------|--------|
| `PROXY_IMPL` | `nexus` | run (`custom` = [`proxy/lightwell-auth-proxy.js`](proxy/lightwell-auth-proxy.js)) |
| `NEXUS_IMAGE` | `sonatype/nexus3:latest` | run / build |
| `NEXUS_PLATFORM` | `linux/amd64` | Nexus container platform (same pin as the test image); `native` for host arch |
| `NEXUS_FRESH` | `0` | wipe Nexus data volume before start when `1` |
| `NEXUS_ADMIN_PASSWORD` | `Password1!` | Nexus admin after first-boot change |
| `NEXUS_PUBLISH_HOST_PORT` | `0` | publish Nexus on host (UI); also on for `MODE=proxy` |
| `UPSTREAM_REGISTRY_URL` | `https://registry.npmjs.org` | manager |
| `LIGHTWELL_REGISTRY_URL` | `https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated` | manager (vanity URL not routed yet) |
| `LIGHTWELL_AUTH_PROXY_PORT` | `8081` (nexus) / `4874` (custom) | host publish when UI is enabled |
| `ATTESTATION_OCI_PREFIX` | Quay validated build prefix | test |
| `ONLY_PACKAGE` / `NODE_MAJOR` | unset | test |
| `PROXY_BYPASS_CDN_CACHE` | `1` (custom proxy only) — CDN bust on Lightwell GETs | custom proxy |
| `PROVENANCE_FALLBACK_QUAY` | unset — when `1`, Quay `.npm` fallback if CDN digest mismatches attestation | test |
| `PROVENANCE_CDN_RETRIES` | `3` | test |

## Registry manager

**Default — Nexus:** stock `sonatype/nexus3`. After boot, [`scripts/nexus-configure.sh`](scripts/nexus-configure.sh) creates `npm-lightwell` + `npm-npmjs` proxies and `npm-group` (Lightwell first). Client registry:

```ini
registry=http://127.0.0.1:8081/repository/npm-group/
```

**Lab-only — custom Node proxy:** [`Dockerfile.proxy`](Dockerfile.proxy) + [`proxy/lightwell-auth-proxy.js`](proxy/lightwell-auth-proxy.js). True prefer-Lightwell for comparison (`PROXY_IMPL=custom`). Not a TP customer deliverable.

```bash
./scripts/run.sh proxy
```

Local tags: `npm-install-test:latest`, `npm-install-proxy:latest` (custom only). Nexus uses `sonatype/nexus3:latest` by default.

## Cosign public key

Bundled: [`keys/redhat-release3.pub`](keys/redhat-release3.pub). Provenance requires cosign-signed DSSE envelopes and an SBOM that carries npm name/version (purl) identity.

## Layout

```
Dockerfile                 # test harness
Dockerfile.proxy           # lab-only prefer-Lightwell dual-registry proxy
proxy/lightwell-auth-proxy.js
inventory/packages.json
harness/
tests/functional/suites.mjs
scripts/build.sh           # pull Nexus + build test (+ optional custom proxy)
scripts/run.sh             # network + Nexus (or custom) + test
scripts/nexus-configure.sh # REST provision npm proxies + group
scripts/entrypoint.sh      # test container only
```
