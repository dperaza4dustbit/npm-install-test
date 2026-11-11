# Customer internal notes: Lightwell validated npm (JavaScript)

Internal / engineering notes for the TP dual-registry proxy and Verdaccio reference. For the docs-writer insertion brief, see [`customer-external-recommendations.md`](customer-external-recommendations.md). Pulp packument gap: [`pulp-npm-packument-requirement.md`](pulp-npm-packument-requirement.md).

## Tech preview status

Lightwell Network JavaScript **Validated** is a **technology preview**.

- Not recommended for production workloads.
- Catalog coverage and registry metadata are still evolving.
- Until Pulp serves full npm packuments, customers should not treat a direct Pulp uplink as a drop-in `registry.npmjs.org` replacement.
- Supported TP pattern: **HTTP dual-registry proxy** (Lightwell first, upstream on miss), with Lightwell credentials only on the proxy.

Customer-facing repository URL (same pattern as Java / Python docs):

| Ecosystem | Validated URL |
|---|---|
| Python | `https://packages.redhat.com/lightwell/python/validated` (+ `/simple` for pip) |
| Java | `https://packages.redhat.com/lightwell/java/validated/` |
| JavaScript | `https://packages.redhat.com/lightwell/javascript/validated` |

Do **not** publish the `/api/pulp-content/...` content-app path in customer docs. This harness may still default to that path until the public URL is cut over.

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

The proxy injects Basic auth toward Lightwell. Client `.npmrc` must **not** hold these credentials when using the proxy pattern.

### Not the same: Lightwell Network API access

Hybrid Cloud Console service account (`CLIENT_ID` / `CLIENT_SECRET`) → short-lived Bearer token for `console.redhat.com` APIs. Different credential set; do not mix with npm Basic auth.

## Recommended TP topology: HTTP proxy + upstream fallback

```text
npm / yarn / pnpm
        │
        ▼
  org HTTP proxy  (Lightwell Basic auth lives here only)
        │
        ├─ hit  → https://packages.redhat.com/lightwell/javascript/validated
        └─ miss → customer upstream (default: registry.npmjs.org)
```

Why a proxy (TP):

1. Prefer Lightwell validated tarballs when present.
2. Fall back to upstream for the rest of the graph.
3. Keep SA credentials off developer laptops / CI job `.npmrc` files.
4. Work around Pulp stub packuments and absolute `dist.tarball` URLs that break naive uplinks.

### Client `.npmrc`

```ini
registry=http://127.0.0.1:4874/
```

### Run the reference proxy from this repo

```bash
./scripts/build.sh
export SERVICE_ACCOUNT_USERNAME='XXXXXXX|service-account-name'
export SERVICE_ACCOUNT_PASSWORD='...'
# optional: UPSTREAM_REGISTRY_URL=https://your.artifactory.example/npm/
./scripts/run.sh proxy
```

| Variable | Role |
|---|---|
| `SERVICE_ACCOUNT_USERNAME` / `SERVICE_ACCOUNT_PASSWORD` | Registry SA → Lightwell Basic auth |
| `LIGHTWELL_REGISTRY_URL` | Customer docs URL above; harness may still default to `/api/pulp-content/...` |
| `UPSTREAM_REGISTRY_URL` | Miss fallback (default `https://registry.npmjs.org`) |

Implementation: [`../proxy/lightwell-auth-proxy.js`](../proxy/lightwell-auth-proxy.js).

## Reference implementation: Verdaccio

[`../verdaccio/config.yaml.template`](../verdaccio/config.yaml.template).

### TP caveat

Direct Verdaccio uplink to Pulp today often fails (stub packuments; absolute tarball URLs → 401 on CDN redirects).

**TP topology that works:**

```text
npm client → Verdaccio → lightwell-auth-proxy → packages.redhat.com
                      ↘ npmjs.org (or customer upstream)
```

### Example Verdaccio config

```yaml
storage: ./storage

web:
  enable: false
  title: Lightwell npm proxy

auth:
  htpasswd:
    file: ./htpasswd
    max_users: -1

uplinks:
  lightwell:
    # TP: auth-injecting proxy, not Pulp directly.
    # After Pulp packuments + auth-safe tarball URLs:
    #   url: https://packages.redhat.com/lightwell/javascript/validated
    #   plus uplink Basic auth with the registry service account.
    url: http://127.0.0.1:4874/
    timeout: 120s
    maxage: 30m
    cache: true
  npmjs:
    url: https://registry.npmjs.org/
    timeout: 60s
    maxage: 30m
    cache: true

packages:
  '@lightwell/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: lightwell

  '@*/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: lightwell npmjs

  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: lightwell npmjs

middlewares:
  audit:
    enabled: false

logs: { type: stdout, format: pretty, level: http }

listen: 127.0.0.1:4873
```

### Post-Pulp (target)

- Verdaccio `lightwell.url` → `https://packages.redhat.com/lightwell/javascript/validated`
- Uplink Basic auth → same registry SA username + token as Java/Python
- Remove the custom Node proxy from the customer path
- Keep dual-uplink order: Lightwell then upstream

## How this repo validates the story

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
./scripts/build.sh
./scripts/run.sh all
```
