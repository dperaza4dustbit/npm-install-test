#!/usr/bin/env bash
# Start the dual-registry proxy container, then run the test container against it.
# Pulp credentials go to the proxy only. Upstream defaults to registry.npmjs.org.
#
# Usage:
#   ./scripts/run.sh              # mode=all
#   ./scripts/run.sh functional
#   ./scripts/run.sh proxy        # proxy only (foreground); Ctrl-C to stop
#   ONLY_PACKAGE=cors@2.8.6 ./scripts/run.sh functional
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if [[ -f "${ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi

IMAGE_NAME="${IMAGE_NAME:-npm-install-test}"
PROXY_IMAGE_NAME="${PROXY_IMAGE_NAME:-npm-install-proxy}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
MODE="${1:-all}"
shift || true

NETWORK_NAME="${NETWORK_NAME:-npm-install-test-net}"
PROXY_CONTAINER="${PROXY_CONTAINER:-npm-install-proxy}"
PROXY_PORT="${LIGHTWELL_AUTH_PROXY_PORT:-4874}"
PROXY_DNS_NAME="${PROXY_DNS_NAME:-npm-install-proxy}"
UPSTREAM_REGISTRY_URL="${UPSTREAM_REGISTRY_URL:-https://registry.npmjs.org}"
PROXY_PUBLIC_URL="${PROXY_PUBLIC_URL:-http://${PROXY_DNS_NAME}:${PROXY_PORT}}"
NPM_PROXY_URL="${NPM_PROXY_URL:-http://${PROXY_DNS_NAME}:${PROXY_PORT}}"
MISS_VOLUME="${MISS_VOLUME:-npm-install-test-proxy-misses}"

if [[ -z "${SA_ENV_FILE:-}" ]]; then
  : "${SERVICE_ACCOUNT_USERNAME:?Set SERVICE_ACCOUNT_USERNAME (Pulp read-only SA)}"
  : "${SERVICE_ACCOUNT_PASSWORD:?Set SERVICE_ACCOUNT_PASSWORD (Pulp read-only SA)}"
fi

PROXY_ENV=(
  -e "UPSTREAM_REGISTRY_URL=${UPSTREAM_REGISTRY_URL}"
  -e "PROXY_PUBLIC_URL=${PROXY_PUBLIC_URL}"
  -e "LIGHTWELL_AUTH_PROXY_PORT=${PROXY_PORT}"
  -e "LIGHTWELL_AUTH_PROXY_BIND=0.0.0.0"
  -e "PROXY_MISS_LOG=/tmp/npm-proxy-misses.jsonl"
)
if [[ -n "${PROXY_BYPASS_CDN_CACHE:-}" ]]; then
  PROXY_ENV+=(-e "PROXY_BYPASS_CDN_CACHE=${PROXY_BYPASS_CDN_CACHE}")
fi
if [[ -n "${SA_ENV_FILE:-}" ]]; then
  PROXY_ENV+=(--env-file "${SA_ENV_FILE}")
else
  PROXY_ENV+=(-e SERVICE_ACCOUNT_USERNAME -e SERVICE_ACCOUNT_PASSWORD)
fi
if [[ -n "${LIGHTWELL_REGISTRY_URL:-}" ]]; then
  PROXY_ENV+=(-e LIGHTWELL_REGISTRY_URL)
fi

cleanup() {
  docker rm -f "${PROXY_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1 || docker network create "${NETWORK_NAME}" >/dev/null
docker volume inspect "${MISS_VOLUME}" >/dev/null 2>&1 || docker volume create "${MISS_VOLUME}" >/dev/null
docker rm -f "${PROXY_CONTAINER}" >/dev/null 2>&1 || true

echo "[run] proxy=${PROXY_IMAGE_NAME}:${IMAGE_TAG} upstream=${UPSTREAM_REGISTRY_URL}"
docker run -d \
  --name "${PROXY_CONTAINER}" \
  --network "${NETWORK_NAME}" \
  --network-alias "${PROXY_DNS_NAME}" \
  --platform "${PLATFORM}" \
  -p "${PROXY_PORT}:4874" \
  -v "${MISS_VOLUME}:/tmp" \
  "${PROXY_ENV[@]}" \
  "${PROXY_IMAGE_NAME}:${IMAGE_TAG}" >/dev/null

echo "[run] waiting for proxy on http://127.0.0.1:${PROXY_PORT}/-/ping"
ready=0
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:${PROXY_PORT}/-/ping" >/dev/null 2>&1; then
    echo "[run] proxy ready"
    ready=1
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "${PROXY_CONTAINER}" 2>/dev/null | grep -q true; then
    echo "[run] proxy container exited:" >&2
    docker logs "${PROXY_CONTAINER}" >&2 || true
    exit 1
  fi
  sleep 0.1
done
if [[ "${ready}" -ne 1 ]]; then
  echo "[run] proxy failed to become ready" >&2
  docker logs "${PROXY_CONTAINER}" >&2 || true
  exit 1
fi

if [[ "${MODE}" == "proxy" ]]; then
  echo "[run] proxy-only mode"
  echo "[run] client .npmrc: registry=http://127.0.0.1:${PROXY_PORT}/"
  echo "[run] (Docker network) registry=${NPM_PROXY_URL}/"
  docker logs -f "${PROXY_CONTAINER}"
  exit 0
fi

TEST_ENV=(
  -e "NPM_PROXY_URL=${NPM_PROXY_URL}"
  -e "PROXY_MISS_LOG=/tmp/npm-proxy-misses.jsonl"
)
for var in \
  ATTESTATION_OCI_PREFIX \
  ONLY_PACKAGE \
  NODE_MAJOR \
  PROVENANCE_FALLBACK_QUAY \
  PROVENANCE_CDN_RETRIES
do
  if [[ -n "${!var:-}" ]]; then
    TEST_ENV+=(-e "${var}")
  fi
done

echo "[run] test=${IMAGE_NAME}:${IMAGE_TAG} mode=${MODE} proxy=${NPM_PROXY_URL}"
docker run --rm \
  --platform "${PLATFORM}" \
  --network "${NETWORK_NAME}" \
  -v "${MISS_VOLUME}:/tmp" \
  "${TEST_ENV[@]}" \
  "${IMAGE_NAME}:${IMAGE_TAG}" \
  "${MODE}" "$@"
