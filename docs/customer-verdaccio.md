# Customer setup: dual-registry proxy for Lightwell validated npm

## Goal

- Prefer Red Hat Lightwell **validated** packages when present
- Fall back to `registry.npmjs.org` for everything else
- Keep Lightwell service-account credentials on the proxy host only

## Recommended proxy (this repo)

Use [`../proxy/lightwell-auth-proxy.js`](../proxy/lightwell-auth-proxy.js) as the client registry. It:

1. Tries Lightwell Pulp with HTTP Basic
2. Follows redirects and **strips** `Authorization` on cross-host hops (CDN/object storage) — required for Pulp tarballs
3. On 404, falls back to `registry.npmjs.org`
4. Rewrites absolute tarball URLs in metadata so follow-up downloads stay on the proxy

**Temporary (not the long-term customer contract):** the same proxy also expands Pulp stub packuments and recomputes `dist.integrity`, and remaps some native package names to `@lightwell/*`. Those exist because Pulp does not yet serve full npm metadata — see [`pulp-npm-packument-requirement.md`](pulp-npm-packument-requirement.md). After Pulp lands that requirement (and Tier B uses upstream platform names), customers should only need auth + URL rewrite (+ optional npmjs fallback).

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
export LIGHTWELL_REGISTRY_URL='https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated'
export LIGHTWELL_AUTH_PROXY_PORT=4874
node proxy/lightwell-auth-proxy.js
```

Client `.npmrc`:

```ini
registry=http://127.0.0.1:4874/
```

## Why not Verdaccio alone?

Verdaccio is a fine off-the-shelf npm proxy, but with Pulp it hits a sharp edge:

1. Uplink metadata from Lightwell contains **absolute** `dist.tarball` URLs on `packages.redhat.com`
2. Verdaccio later downloads those URLs **directly**, not through the uplink auth settings
3. Result: `bad uplink status code: 401` (or plain 401) on `.tgz` fetches — often for larger packages — while smaller ones may succeed depending on caching/redirects

Putting Verdaccio in front of this auth proxy does **not** fix that, because Verdaccio still prefers the absolute remote tarball URL stored from metadata.

If you already run Verdaccio elsewhere, point its `lightwell` uplink at this proxy **and** ensure tarball URLs consumers hit never go straight to `packages.redhat.com` without credentials. The reliable approach for Lightwell/Pulp is: **clients → this dual-registry proxy**.

## Smoke check

```bash
npm ping --registry http://127.0.0.1:4874/
npm view cors@2.8.6 version --registry http://127.0.0.1:4874/
npm view left-pad version --registry http://127.0.0.1:4874/   # npmjs fallback
```

## How this repo validates the doc

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
./scripts/build.sh
./scripts/run.sh all
```

The harness installs the frozen inventory through the same dual-registry proxy.
