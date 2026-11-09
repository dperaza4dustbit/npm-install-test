# Customer setup: dual-registry proxy for Lightwell validated npm

## Goal

- Prefer Red Hat Lightwell **validated** packages when present
- Fall back to the customer’s upstream registry (lab default: `registry.npmjs.org`)
- Keep Lightwell service-account credentials on the proxy host/container only

## Tech preview (this repo)

Until Pulp serves full npm packuments (see [`pulp-npm-packument-requirement.md`](pulp-npm-packument-requirement.md)), ship/run the slim proxy image:

```bash
./scripts/build.sh
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
# optional: UPSTREAM_REGISTRY_URL=https://your.artifactory.example/npm/
./scripts/run.sh proxy
```

Client `.npmrc`:

```ini
registry=http://127.0.0.1:4874/
```

Credentials are **not** in `.npmrc`. Set `UPSTREAM_REGISTRY_URL` to the customer registry when not using the public npm registry.

**Temporary inside the proxy:** expand Pulp stub packuments from the validated `.tgz` (`package/package.json`) and recompute `dist.integrity`. That goes away when Pulp lands the requirement.

## Target (after Pulp is a normal npm uplink)

Standard Verdaccio (or Artifactory/Nexus) dual-uplink — Basic auth on Lightwell, none (or separate auth) on the customer upstream. No custom Node proxy.

## Why not Verdaccio against Pulp today?

1. Stub packuments omit dependency metadata npm needs before downloading tarballs
2. Absolute `dist.tarball` URLs on `packages.redhat.com` are fetched outside uplink auth → 401

## How this repo validates

```bash
export SERVICE_ACCOUNT_USERNAME='...'
export SERVICE_ACCOUNT_PASSWORD='...'
./scripts/build.sh
./scripts/run.sh all
```

`run.sh` starts the proxy container, then the test container with `registry` pointed at the proxy on a shared Docker network.
