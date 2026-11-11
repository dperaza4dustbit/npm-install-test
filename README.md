# npm-install-test

Customer-style harness for Red Hat Lightwell **validated** npm packages.

`./scripts/run.sh` starts two containers:

1. **npm-install-proxy** — dual-registry proxy (Lightwell first, configurable upstream on miss; default `registry.npmjs.org`)
2. **npm-install-test** — installs the frozen inventory through that proxy, runs functional smokes, loads `@lightwell/*` natives, verifies SBOM + cosign attestations

Pulp credentials stay on the proxy container only. The test image has no Lightwell SA.

Customer docs brief: [`docs/customer-external-recommendations.md`](docs/customer-external-recommendations.md). Internal TP / proxy notes: [`docs/customer-internal.md`](docs/customer-internal.md). Pulp packument gap: [`docs/pulp-npm-packument-requirement.md`](docs/pulp-npm-packument-requirement.md).

## What it covers

| Gate | What |
|------|------|
| **functional** | 5 smokes × every frozen **parent** package/version. Tier B/C also assert `@lightwell/*` pull/load |
| **binaries** | Focused Tier B/C re-check: load/run `@lightwell/*` |
| **install** | One tree with npm aliases for all parent versions via the proxy; summarizes upstream misses |
| **provenance** | SBOM hard-fail (SPDX + npm identity) + Quay DSSE attestation (cosign verify + subject digest match) |

Frozen inventory: [`inventory/packages.json`](inventory/packages.json).

## Credentials

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
# Or: SA_ENV_FILE=/path/to/sa.env ./scripts/run.sh all
```

Injected into the **proxy** container only.

## Build and run

```bash
./scripts/build.sh
./scripts/run.sh all
```

Other modes: `functional` | `binaries` | `install` | `provenance` | `proxy` (proxy container only, foreground).

```bash
ONLY_PACKAGE=cors@2.8.6 ./scripts/run.sh functional
```

Optional env:

| Variable | Default | Where |
|----------|---------|--------|
| `UPSTREAM_REGISTRY_URL` | `https://registry.npmjs.org` | proxy (customer registry later) |
| `LIGHTWELL_REGISTRY_URL` | Lightwell validated content URL | proxy |
| `LIGHTWELL_AUTH_PROXY_PORT` | `4874` | host publish + proxy |
| `ATTESTATION_OCI_PREFIX` | Quay validated build prefix | test |
| `ONLY_PACKAGE` / `NODE_MAJOR` | unset | test |
| `PROXY_BYPASS_CDN_CACHE` | `1` (default) — append `_cb` + `Cache-Control: no-cache` on Lightwell GETs **including CDN redirect hosts** so post-`ALLOW_CONTENT_REPLACE` provenance does not see stale tarballs; set `0` to disable. Best-effort only — Akamai may keep path-keyed objects until TTL/purge. | proxy |
| `PROXY_TARBALL_PIN_TTL_MS` | `600000` — pin Lightwell `.tgz` bytes after packument expand / first fetch so `dist.integrity` matches the later tarball GET (avoids npm `EINTEGRITY` when CDN bust returns different generations); `0` disables | proxy |
| `PROVENANCE_FALLBACK_QUAY` | unset — when `1`, if proxy/CDN digest still mismatches the attestation after retries, pull the `.tgz` from the Quay `:name-version.npm` artifact (verifies SBOM/attestation; skips customer registry path) | test |
| `PROVENANCE_CDN_RETRIES` | `3` — proxy download attempts when digest mismatches attestation | test |

## Proxy image (TP seed)

[`Dockerfile.proxy`](Dockerfile.proxy) + [`proxy/lightwell-auth-proxy.js`](proxy/lightwell-auth-proxy.js).

```bash
./scripts/run.sh proxy
# .npmrc → registry=http://127.0.0.1:4874/
```

Quay publish path TBD. Local tags: `npm-install-proxy:latest`, `npm-install-test:latest`.

## Cosign public key

Bundled: [`keys/redhat-release3.pub`](keys/redhat-release3.pub). Provenance requires cosign-signed DSSE envelopes and an SBOM that carries npm name/version (purl) identity.

## Layout

```
Dockerfile                 # test harness
Dockerfile.proxy           # slim dual-registry proxy
proxy/lightwell-auth-proxy.js
inventory/packages.json
harness/
tests/functional/suites.mjs
scripts/build.sh           # builds both images
scripts/run.sh             # network + proxy + test
scripts/entrypoint.sh      # test container only
```
