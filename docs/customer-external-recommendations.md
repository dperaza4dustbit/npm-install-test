# Customer external recommendations: updating Lightwell Network docs for JavaScript

Brief for a docs writer updating [Lightwell Network](https://docs.redhat.com/en/documentation/lightwell_network/current/) (AEM: `/content/dam/ccs-docs/lightwell-network/`).

Part 1 is the **content** we need in the product docs. Part 2 is **suggested** places to put it—use those as a starting point; place and shape topics however fits the existing set best.

Lab-only / engineering notes stay in [`customer-internal.md`](customer-internal.md). Do **not** document home-grown or lab-only proxies in customer topics.

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

Same registry service account as Java / Python:

- Create account: [Create a Lightwell Network service account](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-create_a_red_hat_lightwell_network_service_account)
- Username: `XXXXXXX|service-account-name`
- Password: registry token from that page
- Use as HTTP Basic on the Lightwell remote in the org artifact manager (or, for a simple Lightwell-only lab, in npm auth settings)

Keep this separate from [Lightwell Network API access](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-lightwell_network_api_access) (Hybrid Console Bearer token for `console.redhat.com` APIs).

### Dual-registry pattern (artifact manager required for npm)

Customers who still need community (or private) packages need an **npm-capable artifact manager** in front of Lightwell—for example Artifactory or Nexus, the same class of manager already used for Java and Python.

Unlike Java/Python, **npm clients generally need that manager for dual-target use**. Maven can list multiple repositories and pip can use `index-url` + `extra-index-url`; npm’s default model is a single `registry=` for unscoped packages, so “prefer Lightwell, else upstream” is not something the client does alone. Pointing `.npmrc` only at Lightwell is fine for a Lightwell-only lab install, but not for apps that still need community packages from upstream.

```text
npm / yarn / pnpm
        │
        ▼
  org artifact manager
        │
        ├─ prefer → https://packages.redhat.com/lightwell/javascript/validated
        └─ else   → customer upstream or https://registry.npmjs.org
```

Required behavior (npm-specific; any manager must deliver this):

1. **Packuments** — merge Lightwell + upstream version catalogs; when the same version exists in both, **Lightwell wins** (so `dist.integrity` / tarball metadata match validated bytes).
2. **Tarballs** — resolve Lightwell first; if that version is not on Lightwell, use upstream.
3. Lightwell remote URL + Basic auth (service account username + token) on the manager, not in developer `.npmrc`.
4. Second remote for packages / versions Lightwell does not host.
5. Developers point `.npmrc` `registry=` at the manager’s aggregated npm endpoint, not only at Lightwell, when they need fallback.

> **Important — do not expose this manager on the public internet.**  
> An org registry that holds Lightwell service-account credentials and caches validated packages will serve those authenticated builds to whoever can reach it. Treat it like an internal registry: private network / VPN, auth in front of the manager, and no anonymous public listen. A publicly reachable dual-remote proxy effectively redistributes Red Hat Lightwell validated content to the world.

Please surface this as a strong admonition in the Configure artifact-manager topic and near `.npmrc` examples that point at the manager.

### Configure the artifact manager (Nexus steps)

Suggested topic under [Configure your artifact repository manager](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_your_artifact_repository_manager), sibling to existing Java/Python manager pages.

Document concrete **Nexus** steps that we have lab-verified (Nexus Repository Community / `sonatype/nexus3`). Prefer behavior: two npm proxies plus a group with Lightwell first.

1. Create an npm **proxy** repository for Lightwell (name illustrative: `npm-lightwell`).
   - Remote URL: `https://packages.redhat.com/lightwell/javascript/validated`
   - Authentication: HTTP Basic with the registry service account username + token
2. Create an npm **proxy** repository for upstream (name illustrative: `npm-npmjs`).
   - Remote URL: `https://registry.npmjs.org` (or the customer’s existing npm upstream)
3. Create an npm **group** repository (name illustrative: `npm-group`).
   - Members **in order**: `npm-lightwell`, then `npm-npmjs`
4. Point developer / CI `.npmrc` at the group only:

```ini
registry=https://npm-proxy.example.corp/repository/npm-group/
```

5. Do **not** put the Lightwell service-account token in developer `.npmrc` — it stays on the `npm-lightwell` proxy.
6. Keep the group/manager off the public internet (see admonition above).

**SSRF note (corp/split DNS):** If creating the Lightwell npm proxy fails because the host resolves to a private/local IP, allowlist `packages.redhat.com` (and its resolved addresses if required) in Nexus SSRF protection. Most public-internet installs resolve that hostname to public addresses and do not need this.

This Nexus procedure is reference documentation from our development / validation testing. For a more robust, production-ready artifact-manager configuration (HA, authz, cache policy, TLS, SaaS vs self-managed, and equivalents on Artifactory or other managers), follow the vendor’s current documentation while keeping the same prefer behavior: Lightwell first, then upstream; Lightwell wins on version overlap.

### npm client (`.npmrc`)

Suggested new topic parallel to the Java/Python build-tool pages.

**Preferred path (with manager):**

```ini
registry=https://npm-proxy.example.corp/repository/npm-group/
```

(Adjust to the customer’s aggregated npm URL. The example matches the Nexus reference above.)

Lightwell credentials live on the manager remote; developers do not need them in local `.npmrc` for that setup.

**Optional direct path (lab / Lightwell-only installs):**

Point `registry` at `https://packages.redhat.com/lightwell/javascript/validated` and configure npm with the same service account username + token (`_auth` / `always-auth` or equivalent). Useful for smoke tests; less useful when the app still needs packages only on upstream npm.

Scoped registries (e.g. `@myorg`) can stay as customers already have them.

### What we are not asking you to document

- JavaScript Remediated or Predisclosure repository URLs
- Full production hardening / HA / vendor-specific deep dives (point to vendor docs in the short end note instead)
- pulp-content or other internal registry URLs

---

## Part 2 — Suggested insertion points

These are recommendations only. Fold content into existing topics, add new children, or restructure if that reads better.

| Content (from Part 1) | Suggested home in today’s docs |
|---|---|
| TP + Validated-only for JS | [Lightwell Network repositories](https://docs.redhat.com/en/documentation/lightwell_network/current/discover-lightwell_network_repositories) and/or [Choose the right repository](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-choose_the_right_repository) |
| Service account reuse | Link to [Create a Lightwell Network service account](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-create_a_red_hat_lightwell_network_service_account); light mention under [repository access](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-authenticate_to_lightwell_network) if you list client auth there |
| API vs registry auth | Only if you cross-link; keep [API access](https://docs.redhat.com/en/documentation/lightwell_network/current/get_started-lightwell_network_api_access) about Bearer/console APIs |
| Artifact manager + Nexus steps | New child under [Configure your artifact repository manager](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_your_artifact_repository_manager), sibling to existing Java/Python manager pages |
| `.npmrc` / npm client | New child under “Configure your build tool,” alongside [Python](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_python_build_tool) and [Java](https://docs.redhat.com/en/documentation/lightwell_network/current/configure-configure_java_build_tool) |

### Possible topic titles

- Configure Nexus for the Lightwell Network JavaScript repository
- Configure your npm client to use the Lightwell Network repository

Feel free to rename to match existing title patterns.

---

## Optional checklist

- [ ] TP / not-for-production called out for JS Validated
- [ ] Validated URL uses the `packages.redhat.com/lightwell/javascript/validated` form
- [ ] Auth matches Java/Python registry service account wording
- [ ] Artifact manager required for npm dual-target; packument merge + Lightwell-wins-on-overlap called out
- [ ] Configure procedure uses **Nexus only** as the verified reference; other managers deferred to vendor docs
- [ ] Strong note: manager must stay off the public internet (authenticated validated builds)
- [ ] npm client prefers pointing at the org aggregated npm endpoint
- [ ] Customer topics use the vanity Validated URL only (no lab proxies, Verdaccio “prefer” guides, or pulp-content URLs)
