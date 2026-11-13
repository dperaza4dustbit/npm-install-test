# Requirement: full npm packuments from Lightwell Pulp

**Status:** Pulp reported the packument / integrity gaps fixed. This repo’s temporary stub-expand proxy workaround has been **removed**. Keep this doc as the historical requirement and acceptance checklist.

**Customer goal:** a dumb auth passthrough (credentials + optional npmjs fallback + tarball URL rewrite), or a standard manager uplink (Verdaccio / Artifactory / Nexus) with Basic auth. No packument expand/remap/SRI logic in customer-owned proxies.

Upstream trackers: [pulp_npm#435](https://github.com/pulp/pulp_npm/issues/435), [pulp_npm#438](https://github.com/pulp/pulp_npm/pull/438).

## Why packuments matter

For packages installed **from a registry**, npm builds the dependency tree from **registry metadata** (the packument / version document), **before** treating the tarball as the source of truth for what else to fetch.

So the `package.json` inside the Lightwell `.tgz` can be perfect, and npm will still **not** install declared deps if Pulp’s packument omits `dependencies`. That was the stub-metadata failure mode.

## Acceptance check (no smart proxy)

```bash
# With only Basic auth to Lightwell (or a dumb rewrite proxy):
npm view cors@2.8.6 dependencies --registry "$LIGHTWELL_REGISTRY_URL"
# non-empty, matches packed package.json

npm install cors@2.8.6 --registry "$LIGHTWELL_REGISTRY_URL"
# installs object-assign and vary (or whatever the packed manifest declares)
```

Same check for a Tier B main package: `optionalDependencies` must list the platform package name Lightwell publishes, and that platform packument must resolve.

## What this repo does now

The harness default is **Nexus** (`PROXY_IMPL=nexus`, provisioned by [`../scripts/nexus-configure.sh`](../scripts/nexus-configure.sh)). A lab-only dual-registry Node proxy remains at [`lightwell-auth-proxy.js`](../proxy/lightwell-auth-proxy.js) (`PROXY_IMPL=custom`):

1. Lightwell with Basic auth (strip Authorization on cross-host redirects)
2. 404 → upstream
3. Rewrite absolute tarball hosts onto the proxy
4. Optional merge of npmjs packument **version sets** for dual-registry range resolution

Neither expands stub packuments from `.tgz` contents nor recomputes `dist.integrity`.

## Historical requirement (for reference)

For every npm package version published to Lightwell, Pulp needed to:

1. **Store** the version manifest at upload/publish time
2. **Serve** dependency fields (`dependencies`, `optionalDependencies`, …) on packuments
3. **Generate `dist`** (`tarball`, `integrity`, optional `shasum`) from stored artifact bytes
4. **Backfill** existing content where needed

Those items were the gap this harness previously worked around.
