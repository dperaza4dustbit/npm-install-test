# npm-install-test

Customer-style harness for Red Hat Lightwell **validated** npm packages.

It starts a **dual-registry proxy** (Lightwell first, npmjs.org on miss), installs the frozen inventory through that proxy, runs five functional smokes per parent package, loads `@lightwell/*` native binaries, and verifies SBOM + cosign attestations.

Customer proxy guide: [`docs/customer-verdaccio.md`](docs/customer-verdaccio.md) (filename kept for history; the recommended proxy is `proxy/lightwell-auth-proxy.js`).

## What it covers

| Gate | What |
|------|------|
| **functional** | 5 smokes × every frozen **parent** package/version. Tier B/C also assert `@lightwell/*` pull/load |
| **binaries** | Focused Tier B/C re-check: load/run `@lightwell/*` |
| **install** | One tree with npm aliases for all parent versions via the proxy; summarizes npmjs misses |
| **provenance** | SBOM hard-fail + Quay attestation subject digest match; DSSE/cosign when present (see unsigned note) |

Frozen inventory: [`inventory/packages.json`](inventory/packages.json) (50 entries: 45 parents + 5 `@lightwell/*`).

## Credentials

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
# Or: SA_ENV_FILE=/path/to/sa.env ./scripts/run.sh all
# (preferred for JWT passwords that break shell `source`)
```

Pulp read-only credentials for the Lightwell validated content URL. Injected into the proxy only — not into client `.npmrc`.

## Build and run

```bash
./scripts/build.sh
./scripts/run.sh all
```

Other modes: `functional` | `binaries` | `install` | `provenance` | `proxy`.

```bash
ONLY_PACKAGE=cors@2.8.6 ./scripts/run.sh functional
```

Optional env: `LIGHTWELL_REGISTRY_URL`, `ATTESTATION_OCI_PREFIX`, `ONLY_PACKAGE`, `NODE_MAJOR`, `LIGHTWELL_AUTH_PROXY_PORT` (default `4874`).

## Proxy

[`proxy/lightwell-auth-proxy.js`](proxy/lightwell-auth-proxy.js) — Lightwell (Basic auth + safe redirects) then npmjs.

**Verdaccio note:** Verdaccio alone is a poor fit for Pulp because it re-downloads absolute `packages.redhat.com` tarball URLs without uplink credentials (401 on `.tgz`). See the customer doc.

## Cosign public key

Bundled: [`keys/redhat-release3.pub`](keys/redhat-release3.pub) (release key 3).

Attestation OCI tags currently publish a bare in-toto Statement (subject digest matches the `.tgz`). Cosign DSSE signatures are not present yet; the image defaults `PROVENANCE_ALLOW_UNSIGNED=1` so subject checks still gate the suite. Unset it (or set `0`) once Lightwell publishes signed DSSE envelopes.

## Layout

```
inventory/packages.json
keys/redhat-release3.pub
proxy/lightwell-auth-proxy.js
docs/customer-verdaccio.md
harness/
tests/functional/suites.mjs
fixture/package.json
scripts/build.sh
scripts/run.sh
scripts/entrypoint.sh
Dockerfile
```
