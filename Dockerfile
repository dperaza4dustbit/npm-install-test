# Customer-style install/provenance/smoke harness for Lightwell validated npm.
# Talks to a separate dual-registry manager (Nexus by default; see scripts/run.sh).
# Default Node is 22; Node 20 is also installed for packages that need it.
FROM registry.access.redhat.com/ubi9/ubi:latest

ARG NODE22_VERSION=22.14.0
ARG NODE20_VERSION=20.18.3
ARG COSIGN_VERSION=2.4.1
ARG ORAS_VERSION=1.2.2

USER root
# UBI9 already has curl-minimal; installing curl conflicts with it.
RUN dnf -y install ca-certificates tar gzip findutils jq python3 \
    && dnf clean all

# Node 22 (default) + Node 20 side-by-side
RUN mkdir -p /usr/local/lib/nodejs \
    && curl -fsSL "https://nodejs.org/dist/v${NODE22_VERSION}/node-v${NODE22_VERSION}-linux-x64.tar.gz" \
      | tar -xz -C /usr/local/lib/nodejs \
    && curl -fsSL "https://nodejs.org/dist/v${NODE20_VERSION}/node-v${NODE20_VERSION}-linux-x64.tar.gz" \
      | tar -xz -C /usr/local/lib/nodejs \
    && ln -sfn "/usr/local/lib/nodejs/node-v${NODE22_VERSION}-linux-x64" /usr/local/lib/nodejs/node22 \
    && ln -sfn "/usr/local/lib/nodejs/node-v${NODE20_VERSION}-linux-x64" /usr/local/lib/nodejs/node20 \
    && ln -sfn /usr/local/lib/nodejs/node22/bin/node /usr/local/bin/node \
    && ln -sfn /usr/local/lib/nodejs/node22/bin/npm /usr/local/bin/npm \
    && ln -sfn /usr/local/lib/nodejs/node22/bin/npx /usr/local/bin/npx

# cosign + oras
RUN curl -fsSL -o /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64" \
    && chmod 0755 /usr/local/bin/cosign \
    && curl -fsSL \
      "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /usr/local/bin oras

COPY . /opt/npm-install-test
WORKDIR /opt/npm-install-test
RUN chmod +x scripts/*.sh harness/*.mjs

ENV PATH="/usr/local/lib/nodejs/node22/bin:/usr/local/bin:${PATH}" \
    NPM_PROXY_URL="http://npm-install-proxy:8081/repository/npm-group" \
    NPM_PROXY_READY_URL="http://npm-install-proxy:8081/service/rest/v1/status" \
    PROXY_MISS_LOG="/tmp/npm-proxy-misses.jsonl" \
    ATTESTATION_OCI_PREFIX="quay.io/redhat-user-workloads/lightwell-javascript-tenant/javascript-validated/javascript-validated-build"

ENTRYPOINT ["/opt/npm-install-test/scripts/entrypoint.sh"]
CMD ["all"]
