# Customer external recommendations: updating Lightwell Network docs for JavaScript

Brief for a docs writer updating [Lightwell Network](https://docs.redhat.com/en/documentation/lightwell_network/current/) (AEM: `/content/dam/ccs-docs/lightwell-network/`).

Part 1 is the **content** we need in the product docs. Part 2 is **suggested** places to put it—use those as a starting point; place and shape topics however fits the existing set best.

**Working assumption:** Pulp npm registry behavior matches a normal npm uplink (full packuments, auth that works with standard managers). Document that path. We will re-test with Verdaccio in `npm-install-test` when the Pulp fix lands and adjust this brief if needed.

Lab-only notes stay in [`customer-internal.md`](customer-internal.md).

---

## Part 1 — Content to add

### Technology preview

- JavaScript **Validated** is a technology preview.
- Soften as you prefer, but customers should understand it is early and not aimed at production use yet.
- Document **Validated only** for npm. Do not add Remediated or Predisclosure JavaScript repository URLs until those tiers exist for this ecosystem.

### Repository URL

Same shape as Java and Python in the current docs:

```text
https://packages.redhat.com/lightwell/javascript/validated
```

| Ecosystem | Validated URL (existing docs) |
|---|---|
| Python | `https://packages.redhat.com/lightwell/python/validated` |
| Java | `https://packages.redhat.com/lightwell/java/validated/` |
| JavaScript | `https://packages.redhat.com/lightwell/javascript/validated` |

### Authentication

Same registry service account as Java / Python / Nexus / Artifactory:

- Create account: [Create a Lightwell Network service account](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-create_a_red_hat_lightwell_network_service_account)
- Username: `XXXXXXX|service-account-name`
- Password: registry token from that page
- Use as HTTP Basic on the Lightwell npm uplink (manager) or, for a simple lab, in npm auth settings

Keep this separate from [Lightwell Network API access](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-lightwell_network_api_access) (Hybrid Console Bearer token for `console.redhat.com` APIs).

### Dual-registry proxy pattern (org registry manager)

Customers who still need community (or private) packages should put an npm-capable registry manager in front of Lightwell, same idea as Artifactory/Nexus for other ecosystems:

```text
npm / yarn / pnpm
        │
        ▼
  org registry manager (e.g. Verdaccio)
        │
        ├─ prefer → https://packages.redhat.com/lightwell/javascript/validated
        └─ else   → customer upstream or https://registry.npmjs.org
```

Points to cover:

1. Lightwell uplink URL and Basic auth (service account username + token).
2. Second uplink for packages Lightwell does not host.
3. Policy: try Lightwell first, then upstream.
4. Developers point `.npmrc` `registry=` at the **manager**, not only at Lightwell, when they need fallback.

> **Important — do not expose this manager on the public internet.**  
> Verdaccio (or any org proxy) that holds Lightwell service-account credentials and caches validated packages will serve those authenticated builds to whoever can reach it. Treat it like an internal registry: private network / VPN, auth in front of the manager, and no anonymous public listen. A publicly reachable dual-uplink proxy effectively redistributes Red Hat Lightwell validated content to the world.

Please surface this as a strong admonition in any Configure Verdaccio / registry-manager topic (and near `.npmrc` examples that point at the manager).

### Verdaccio reference implementation

Suggested new topic (title up to you), with a dual-uplink example. Seed file in this repo: [`../verdaccio/config.yaml.template`](../verdaccio/config.yaml.template). Illustrative config for docs (direct Lightwell uplink—no extra workaround proxy):

```yaml
storage: ./storage

uplinks:
  lightwell:
    url: https://packages.redhat.com/lightwell/javascript/validated
    # Configure Basic auth with the registry service account
    # (username + token), using Verdaccio’s uplink auth mechanism.
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

listen: 127.0.0.1:4873   # example: local/lab only — do not publish 0.0.0.0 without org auth
```

Writers can shorten this, match house style for secrets/auth blocks, or use Artifactory/Nexus npm remotes later instead of Verdaccio. Verdaccio is the reference we will validate in `npm-install-test` after the Pulp fix. Repeat the “not on the public network” note next to any listen/bind example.

### npm client (`.npmrc`)

Suggested new topic parallel to the Java/Python build-tool pages.

**Preferred path (with manager):**

```ini
registry=https://npm-proxy.example.corp/
```

Lightwell credentials live on the manager uplink; developers do not need them in local `.npmrc` for that setup.

**Optional direct path (lab / Lightwell-only installs):**

Point `registry` at `https://packages.redhat.com/lightwell/javascript/validated` and configure npm with the same service account username + token (`_auth` / `always-auth` or equivalent). Useful for smoke tests; less useful when the app still needs packages only on upstream npm.

Scoped registries (e.g. `@myorg`) can stay as customers already have them.

### What we are not asking you to document

- JavaScript Remediated or Predisclosure repository URLs

---

## Part 2 — Suggested insertion points

These are recommendations only. Fold content into existing topics, add new children, or restructure if that reads better.

| Content (from Part 1) | Suggested home in today’s docs |
|---|---|
| TP + Validated-only for JS | [Lightwell Network repositories](https://docs.redhat.com/en/documentation/lightwell_network/current/discover-lightwell_network_repositories) and/or [Choose the right repository](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-choose_the_right_repository) |
| Service account reuse | Link to [Create a Lightwell Network service account](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-create_a_red_hat_lightwell_network_service_account); light mention under [repository access](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-authenticate_to_lightwell_network) if you list client auth there |
| API vs registry auth | Only if you cross-link; keep [API access](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-lightwell_network_api_access) about Bearer/console APIs |
| Verdaccio dual-uplink + URL + Basic auth | New child under [Configure your artifact repository manager](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_your_artifact_repository_manager), sibling to Artifactory/Nexus—or equivalent new manager topic |
| `.npmrc` / npm client | New child under “Configure your build tool,” alongside [Python](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_python_build_tool) and [Java](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_java_build_tool) |
| Artifactory/Nexus npm remotes | Optional later; Verdaccio + npm client is enough for a first JS path |

### Possible topic titles

- Configure Verdaccio to use the Lightwell Network JavaScript repository
- Configure your npm client to use the Lightwell Network repository

Feel free to rename to match existing title patterns.

---

## Optional checklist

- [ ] TP / not-for-production called out for JS Validated
- [ ] Validated URL uses the `packages.redhat.com/lightwell/javascript/validated` form
- [ ] Auth matches Java/Python registry service account wording
- [ ] Dual-uplink (Lightwell then upstream) explained; Verdaccio example included or linked
- [ ] Strong note: manager/proxy must stay off the public internet (authenticated validated builds)
- [ ] npm client prefers pointing at the org manager
- [ ] No lab workaround proxies or pulp-content URLs in customer topics
