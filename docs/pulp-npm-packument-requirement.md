# Requirement: full npm packuments from Lightwell Pulp

**Status:** blocked on Pulp / `pulp_npm` (not fixable in Lightwell factory/release alone right now).  
**Customer goal:** a dumb auth passthrough proxy (credentials + optional npmjs fallback + tarball URL rewrite). No packument expand/remap/SRI logic in customer-owned proxies.  
**Until Pulp ships this:** [`../proxy/lightwell-auth-proxy.js`](../proxy/lightwell-auth-proxy.js) compensates (temporary). Upstream trackers: [pulp_npm#435](https://github.com/pulp/pulp_npm/issues/435), fix direction [pulp_npm#438](https://github.com/pulp/pulp_npm/pull/438).

## Why “deps are already in the tar” is not enough

The common mental model:

1. Proxy fetches `cors` tarball from Lightwell  
2. `npm` opens `package/package.json` inside the tar  
3. Sees `dependencies` / `optionalDependencies`  
4. Asks the same registry (proxy) for those packages  
5. Proxy hits Lightwell, then npmjs on miss  

**That is not how registry installs work.** For packages installed **from a registry** (including via a proxy), npm builds the dependency tree from **registry metadata** (the packument / version document), **before** it treats the tarball as the source of truth for what else to fetch.

Rough order:

1. `GET /cors` (packument) — read `versions["2.8.6"].dependencies`, `optionalDependencies`, `dist.tarball`, `dist.integrity`  
2. Recurse: `GET /object-assign`, `GET /vary`, … using those declared ranges  
3. Only then download each chosen `.tgz`  
4. Extract tarballs; the on-disk `package.json` is what runs at runtime, but **resolution already happened from metadata**

So the `package.json` inside the Lightwell `.tgz` can be perfect, and npm will still **not** install `object-assign` / `vary` if Pulp’s packument for `cors@2.8.6` omits `dependencies`. That is exactly what people hit with stub pulp_npm metadata ([#435](https://github.com/pulp/pulp_npm/issues/435)): the main package installs; declared deps do not.

The tarball is the **payload**. The packument is the **index** npm uses to walk the graph without downloading every tar first (and without unpacking to learn deps). Upstream npm always publishes both; they are supposed to match. Pulp today often stores/serves only enough to find the tarball URL.

A dumb proxy only forwards HTTP. It cannot invent `dependencies` on a stub packument. Either Pulp serves full version metadata (this requirement), or something in front of Pulp synthesizes it (our temporary workaround).

Local/`file:` installs are different: there npm does read `package.json` from disk. Registry installs do not wait on the tar for the tree.

## What is wrong today

`pulp_npm` builds each packument version entry with little more than `_id` and `dist.tarball`. It does **not** serve the packed `package.json` fields npm clients need to resolve the tree (`dependencies`, `optionalDependencies`, `peerDependencies`, `bin`, `engines`, …). `dist.integrity` / `dist.shasum` are often missing or unreliable.

Auth and URL host differ from registry.npmjs.org; **metadata shape is also different**. That second gap is this requirement. The extra metadata is not a second dependency list we invent — it is the **same** fields as in the tar’s `package.json`, copied into the registry API so npm can resolve without unpacking.

## Example: upstream npm (expected)

Abbreviated install metadata for a version must carry dependency fields and a trustworthy `dist`, for example:

```json
{
  "name": "cors",
  "versions": {
    "2.8.6": {
      "name": "cors",
      "version": "2.8.6",
      "dependencies": {
        "object-assign": "^4",
        "vary": "^1"
      },
      "dist": {
        "tarball": "https://registry.npmjs.org/cors/-/cors-2.8.6.tgz",
        "integrity": "sha512-…",
        "shasum": "…"
      }
    }
  },
  "dist-tags": { "latest": "2.8.6" }
}
```

Tier B optional natives need the same for the main package, e.g. `esbuild` listing `@lightwell/esbuild-linux-x64` in `optionalDependencies` with a correct `dist` on that platform package’s own packument.

## Example: Pulp today (actual)

GET on the Lightwell content URL for the same package typically looks like:

```json
{
  "name": "cors",
  "versions": {
    "2.8.6": {
      "_id": "cors@2.8.6",
      "dist": {
        "tarball": "https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated/cors/-/cors-2.8.6.tgz"
      }
    }
  },
  "dist-tags": { "latest": "2.8.6" }
}
```

Effects:

- `npm` / `pnpm` do not install transitive deps from the Lightwell version document (they are not listed).
- Clients that verify `dist.integrity` may fail or skip checks when integrity is absent/wrong.
- A passthrough auth proxy cannot invent this metadata; only Pulp (or a smart proxy workaround) can.

Per-version GETs (`/{name}/{version}`) are often missing on Pulp content apps as well; upstream npm serves them.

## Requirement (for Pulp / Lightwell registry)

For every npm package version published to Lightwell:

1. **Store** the version manifest at upload/publish time (from the publish body and/or `package/package.json` inside the `.tgz`).
2. **Serve** an allow-listed subset on packument (and ideally `/{name}/{version}`) responses, at least:
   - `name`, `version`, `_id`
   - `dependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`
   - `bundleDependencies`, `bin`, `engines`, `os`, `cpu`, `scripts` (as needed for install)
   - `deprecated`, `hasInstallScript` when applicable
3. **Generate `dist` in Pulp**, never trust publisher-supplied tarball URLs/checksums:
   - `tarball` → distribution content URL
   - `integrity` → sha512 of stored artifact bytes
   - `shasum` → sha1 of the same bytes (if clients still expect it)
4. **Backfill** existing content (migration from stored `.tgz` `package.json`, or re-upload) so already-published Lightwell packages gain manifests; new uploads alone are not enough for the current catalog.

### Question for Pulp (existing Lightwell content)

When the packument/manifest + generated-`dist.integrity` fix ships (see [pulp_npm#435](https://github.com/pulp/pulp_npm/issues/435) / [#438](https://github.com/pulp/pulp_npm/pull/438)):

**Will existing npm content get manifests backfilled from already-stored artifacts (`package/package.json` inside the `.tgz`), or only new uploads/publishes?**

- If **backfill/migration:** Lightwell does **not** need to republish or rebuild for dependency metadata; customers can drop the stub-expand proxy workaround after upgrade.
- If **new uploads only:** Lightwell must **re-upload** each `name@version` (same tarball bytes are enough if `package.json` is already correct — not necessarily a factory rebuild) or otherwise backfill, so the catalog’s existing units gain manifests. `dist.integrity` may still be fine for old content if Pulp generates it from the stored artifact at serve time — please confirm that separately.

Please answer that explicitly in the upgrade notes so we can plan a re-upload wave vs a no-op cutover.

Acceptance check (no smart proxy):

```bash
# With only Basic auth to Lightwell (or a dumb rewrite proxy):
npm view cors@2.8.6 dependencies --registry "$LIGHTWELL_REGISTRY_URL"
# non-empty, matches packed package.json

npm install cors@2.8.6 --registry "$LIGHTWELL_REGISTRY_URL"
# installs object-assign and vary (or whatever the packed manifest declares)
```

Same check for a Tier B main package: `optionalDependencies` must list the platform package name Lightwell publishes, and that platform packument must resolve.

## Temporary workaround (this repo’s proxy)

[`lightwell-auth-proxy.js`](../proxy/lightwell-auth-proxy.js) is **not** the long-term customer contract. Until Pulp meets the requirement above it:

1. Detects stub version objects (`_id` / `dist` / optional `name`+`version` only).
2. Downloads the Lightwell `.tgz` for that version and copies registry fields from `package/package.json` inside it (deps/optionals match what was published — not community npmjs metadata).
3. Recomputes `dist.integrity` from those same tarball bytes.
4. Rewrites absolute tarball hosts onto the proxy (also needed so credentials work; separate from stubs).
5. Optionally merges npmjs packument **versions** so dual-registry range resolution can still pick community versions Lightwell does not host (validated version docs still win on overlay).

When Pulp serves full packuments with correct integrity, remove steps 1–3. Keep auth, redirect handling, optional npmjs 404 fallback, and (if still desired) version-set merge for dual-registry.

## Out of scope here

- Signing / DSSE attestations (release image / `slan-cuan`).
- SBOM richness inside the `.tgz` (`npm-builder`).
