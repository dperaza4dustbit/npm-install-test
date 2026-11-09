# npm-install-test

Customer-style harness for Red Hat Lightwell **validated** npm packages.

`./scripts/run.sh` starts two containers:

1. **npm-install-proxy** — dual-registry proxy (Lightwell first, configurable upstream on miss; default `registry.npmjs.org`)
2. **npm-install-test** — installs the frozen inventory through that proxy, runs functional smokes, loads `@lightwell/*` natives, verifies SBOM + cosign attestations

Pulp credentials stay on the proxy container only. The test image has no Lightwell SA.

Customer / TP notes: [`docs/customer-verdaccio.md`](docs/customer-verdaccio.md). Pulp packument gap: [`docs/pulp-npm-packument-requirement.md`](docs/pulp-npm-packument-requirement.md).

## What it covers

| Gate | What |
|------|------|
| **functional** | 5 smokes × every frozen **parent** package/version. Tier B/C also assert `@lightwell/*` pull/load |
| **binaries** | Focused Tier B/C re-check: load/run `@lightwell/*` |
| **install** | One tree with npm aliases for all parent versions via the proxy; summarizes upstream misses |
| **provenance** | SBOM hard-fail + Quay attestation subject digest match; DSSE/cosign when present (see unsigned note) |

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

## Proxy image (TP seed)

[`Dockerfile.proxy`](Dockerfile.proxy) + [`proxy/lightwell-auth-proxy.js`](proxy/lightwell-auth-proxy.js).

```bash
./scripts/run.sh proxy
# .npmrc → registry=http://127.0.0.1:4874/
```

Quay publish path TBD. Local tags: `npm-install-proxy:latest`, `npm-install-test:latest`.

## Cosign public key

Bundled: [`keys/redhat-release3.pub`](keys/redhat-release3.pub). Test image defaults `PROVENANCE_ALLOW_UNSIGNED=1` until signed DSSE envelopes are published.

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
