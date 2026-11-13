#!/usr/bin/env bash
# Start a dual-registry manager, then run the test container against it.
# Default manager: Nexus Repository Community (npm group, Lightwell before upstream).
# Optional: PROXY_IMPL=custom for the lab-only Node prefer proxy.
# Pulp credentials go to the manager only. Upstream defaults to registry.npmjs.org.
#
# Usage:
#   ./scripts/run.sh              # mode=all
#   ./scripts/run.sh functional
#   ./scripts/run.sh packuments
#   ./scripts/run.sh proxy        # manager only (foreground); Ctrl-C to stop
#   PROXY_IMPL=custom ./scripts/run.sh functional
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
NEXUS_IMAGE="${NEXUS_IMAGE:-sonatype/nexus3:latest}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
# Pin both containers to amd64 so results are not host-arch dependent.
# Override with NEXUS_PLATFORM=linux/arm64 (or empty) if you want native Nexus on Apple Silicon.
PLATFORM="${PLATFORM:-linux/amd64}"
NEXUS_PLATFORM="${NEXUS_PLATFORM:-linux/amd64}"
MODE="${1:-all}"
shift || true

# nexus (default) | custom — custom keeps Dockerfile.proxy / lightwell-auth-proxy.js
PROXY_IMPL="${PROXY_IMPL:-nexus}"

NETWORK_NAME="${NETWORK_NAME:-npm-install-test-net}"
PROXY_CONTAINER="${PROXY_CONTAINER:-npm-install-proxy}"
PROXY_DNS_NAME="${PROXY_DNS_NAME:-npm-install-proxy}"
UPSTREAM_REGISTRY_URL="${UPSTREAM_REGISTRY_URL:-https://registry.npmjs.org}"
# Live content path until vanity URL is routed (vanity currently 404s).
LIGHTWELL_REGISTRY_URL="${LIGHTWELL_REGISTRY_URL:-https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated}"
MISS_VOLUME="${MISS_VOLUME:-npm-install-test-proxy-misses}"
NEXUS_DATA_VOLUME="${NEXUS_DATA_VOLUME:-npm-install-test-nexus-data}"
NEXUS_GROUP_NAME="${NEXUS_GROUP_NAME:-npm-group}"
NEXUS_ADMIN_PASSWORD="${NEXUS_ADMIN_PASSWORD:-Password1!}"
NEXUS_STATE_DIR="${ROOT}/.nexus-run"
NEXUS_FRESH="${NEXUS_FRESH:-0}"
# Publish Nexus UI on the host only for MODE=proxy (or when explicitly requested).
NEXUS_PUBLISH_HOST_PORT="${NEXUS_PUBLISH_HOST_PORT:-0}"

case "${PROXY_IMPL}" in
  nexus)
    PROXY_PORT="${LIGHTWELL_AUTH_PROXY_PORT:-8081}"
    # Container-internal Nexus listen port is always 8081.
    PROXY_INTERNAL_PORT=8081
    NPM_PROXY_URL="${NPM_PROXY_URL:-http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}/repository/${NEXUS_GROUP_NAME}}"
    # Ready check for the test entrypoint (Nexus has no /-/ping).
    NPM_PROXY_READY_URL="${NPM_PROXY_READY_URL:-http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}/service/rest/v1/status}"
    if [[ "${MODE}" == "proxy" || "${NEXUS_PUBLISH_HOST_PORT}" == "1" ]]; then
      NEXUS_PUBLISH_HOST_PORT=1
    else
      NEXUS_PUBLISH_HOST_PORT=0
    fi
    ;;
  custom)
    PROXY_PORT="${LIGHTWELL_AUTH_PROXY_PORT:-4874}"
    PROXY_INTERNAL_PORT=4874
    NPM_PROXY_URL="${NPM_PROXY_URL:-http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}}"
    NPM_PROXY_READY_URL="${NPM_PROXY_READY_URL:-http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}/-/ping}"
    ;;
  *)
    echo "[run] unknown PROXY_IMPL=${PROXY_IMPL} (use nexus|custom)" >&2
    exit 1
    ;;
esac

PROXY_PUBLIC_URL="${PROXY_PUBLIC_URL:-http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}}"

if [[ -z "${SA_ENV_FILE:-}" ]]; then
  : "${SERVICE_ACCOUNT_USERNAME:?Set SERVICE_ACCOUNT_USERNAME (Pulp read-only SA)}"
  : "${SERVICE_ACCOUNT_PASSWORD:?Set SERVICE_ACCOUNT_PASSWORD (Pulp read-only SA)}"
fi

if [[ -n "${SA_ENV_FILE:-}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${SA_ENV_FILE}"
  set +a
  : "${SERVICE_ACCOUNT_USERNAME:?SA_ENV_FILE must set SERVICE_ACCOUNT_USERNAME}"
  : "${SERVICE_ACCOUNT_PASSWORD:?SA_ENV_FILE must set SERVICE_ACCOUNT_PASSWORD}"
fi

cleanup() {
  docker rm -f "${PROXY_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1 || docker network create "${NETWORK_NAME}" >/dev/null
docker volume inspect "${MISS_VOLUME}" >/dev/null 2>&1 || docker volume create "${MISS_VOLUME}" >/dev/null
docker rm -f "${PROXY_CONTAINER}" >/dev/null 2>&1 || true

start_custom_proxy() {
  echo "[run] manager=custom image=${PROXY_IMAGE_NAME}:${IMAGE_TAG} upstream=${UPSTREAM_REGISTRY_URL}"
  local proxy_env=(
    -e "UPSTREAM_REGISTRY_URL=${UPSTREAM_REGISTRY_URL}"
    -e "LIGHTWELL_REGISTRY_URL=${LIGHTWELL_REGISTRY_URL}"
    -e "PROXY_PUBLIC_URL=${PROXY_PUBLIC_URL}"
    -e "LIGHTWELL_AUTH_PROXY_PORT=${PROXY_INTERNAL_PORT}"
    -e "LIGHTWELL_AUTH_PROXY_BIND=0.0.0.0"
    -e "PROXY_MISS_LOG=/tmp/npm-proxy-misses.jsonl"
    -e "SERVICE_ACCOUNT_USERNAME=${SERVICE_ACCOUNT_USERNAME}"
    -e "SERVICE_ACCOUNT_PASSWORD=${SERVICE_ACCOUNT_PASSWORD}"
  )
  if [[ -n "${PROXY_BYPASS_CDN_CACHE:-}" ]]; then
    proxy_env+=(-e "PROXY_BYPASS_CDN_CACHE=${PROXY_BYPASS_CDN_CACHE}")
  fi
  docker run -d \
    --name "${PROXY_CONTAINER}" \
    --network "${NETWORK_NAME}" \
    --network-alias "${PROXY_DNS_NAME}" \
    --platform "${PLATFORM}" \
    -p "${PROXY_PORT}:${PROXY_INTERNAL_PORT}" \
    -v "${MISS_VOLUME}:/tmp" \
    "${proxy_env[@]}" \
    "${PROXY_IMAGE_NAME}:${IMAGE_TAG}" >/dev/null
}

start_nexus() {
  echo "[run] manager=nexus image=${NEXUS_IMAGE} platform=${NEXUS_PLATFORM:-native} lightwell=${LIGHTWELL_REGISTRY_URL} upstream=${UPSTREAM_REGISTRY_URL}"
  if [[ "${NEXUS_FRESH}" == "1" ]]; then
    echo "[run] NEXUS_FRESH=1 — wiping ${NEXUS_DATA_VOLUME}"
    docker volume rm "${NEXUS_DATA_VOLUME}" >/dev/null 2>&1 || true
  fi
  docker volume inspect "${NEXUS_DATA_VOLUME}" >/dev/null 2>&1 || docker volume create "${NEXUS_DATA_VOLUME}" >/dev/null
  mkdir -p "${NEXUS_STATE_DIR}"

  if [[ "${NEXUS_PUBLISH_HOST_PORT}" == "1" ]]; then
    echo "[run] publishing Nexus on host port ${PROXY_PORT} (UI reachable)"
  else
    echo "[run] Nexus host port unpublished (set NEXUS_PUBLISH_HOST_PORT=1 or use MODE=proxy for UI)"
  fi

  # NEXUS_PLATFORM=native (or empty after unset) → omit --platform (Docker host default).
  local use_platform=1
  if [[ -z "${NEXUS_PLATFORM}" || "${NEXUS_PLATFORM}" == "native" ]]; then
    use_platform=0
  fi

  if [[ "${use_platform}" == "1" && "${NEXUS_PUBLISH_HOST_PORT}" == "1" ]]; then
    docker run -d \
      --name "${PROXY_CONTAINER}" \
      --network "${NETWORK_NAME}" \
      --network-alias "${PROXY_DNS_NAME}" \
      --platform "${NEXUS_PLATFORM}" \
      -p "${PROXY_PORT}:${PROXY_INTERNAL_PORT}" \
      -v "${NEXUS_DATA_VOLUME}:/nexus-data" \
      "${NEXUS_IMAGE}" >/dev/null
  elif [[ "${use_platform}" == "1" ]]; then
    docker run -d \
      --name "${PROXY_CONTAINER}" \
      --network "${NETWORK_NAME}" \
      --network-alias "${PROXY_DNS_NAME}" \
      --platform "${NEXUS_PLATFORM}" \
      -v "${NEXUS_DATA_VOLUME}:/nexus-data" \
      "${NEXUS_IMAGE}" >/dev/null
  elif [[ "${NEXUS_PUBLISH_HOST_PORT}" == "1" ]]; then
    docker run -d \
      --name "${PROXY_CONTAINER}" \
      --network "${NETWORK_NAME}" \
      --network-alias "${PROXY_DNS_NAME}" \
      -p "${PROXY_PORT}:${PROXY_INTERNAL_PORT}" \
      -v "${NEXUS_DATA_VOLUME}:/nexus-data" \
      "${NEXUS_IMAGE}" >/dev/null
  else
    docker run -d \
      --name "${PROXY_CONTAINER}" \
      --network "${NETWORK_NAME}" \
      --network-alias "${PROXY_DNS_NAME}" \
      -v "${NEXUS_DATA_VOLUME}:/nexus-data" \
      "${NEXUS_IMAGE}" >/dev/null
  fi
}

case "${PROXY_IMPL}" in
  nexus) start_nexus ;;
  custom) start_custom_proxy ;;
esac

wait_manager_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-200}"
  local sleep_s="${4:-1}"
  echo "[run] waiting for ${label} at ${url}"
  local i
  for i in $(seq 1 "${attempts}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[run] ${label} ready (attempt ${i})"
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "${PROXY_CONTAINER}" 2>/dev/null | grep -q true; then
      echo "[run] manager container exited:" >&2
      docker logs "${PROXY_CONTAINER}" >&2 || true
      return 1
    fi
    if (( i % 15 == 0 )); then
      echo "[run] still waiting for ${label}... ${i}/${attempts}"
    fi
    sleep "${sleep_s}"
  done
  echo "[run] ${label} failed to become ready" >&2
  docker logs "${PROXY_CONTAINER}" >&2 || true
  return 1
}

# Wait via Docker network when Nexus is not published on the host.
wait_manager_http_net() {
  local path="$1"
  local label="$2"
  local attempts="${3:-180}"
  local sleep_s="${4:-2}"
  local url="http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}${path}"
  echo "[run] waiting for ${label} at ${url} (docker network)"
  local i
  for i in $(seq 1 "${attempts}"); do
    if docker run --rm --network "${NETWORK_NAME}" curlimages/curl:8.11.1 \
      -fsS --connect-timeout 2 --max-time 5 "${url}" >/dev/null 2>&1; then
      echo "[run] ${label} ready (attempt ${i})"
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "${PROXY_CONTAINER}" 2>/dev/null | grep -q true; then
      echo "[run] manager container exited:" >&2
      docker logs "${PROXY_CONTAINER}" >&2 || true
      return 1
    fi
    if (( i % 15 == 0 )); then
      echo "[run] still waiting for ${label}... ${i}/${attempts}"
    fi
    sleep "${sleep_s}"
  done
  echo "[run] ${label} failed to become ready" >&2
  docker logs "${PROXY_CONTAINER}" >&2 || true
  return 1
}

configure_nexus() {
  local lw_host ssrf_ips initial_pw
  lw_host="$(echo "${LIGHTWELL_REGISTRY_URL}" | sed -E 's|^https?://([^/:]+).*|\1|')"
  ssrf_ips="$(dig +short A "${lw_host}" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  if [[ -z "${ssrf_ips}" ]]; then
    ssrf_ips="$(getent ahostsv4 "${lw_host}" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  fi
  initial_pw="$(docker exec "${PROXY_CONTAINER}" cat /nexus-data/admin.password 2>/dev/null || true)"

  if [[ "${NEXUS_PUBLISH_HOST_PORT}" == "1" ]]; then
    NEXUS_BASE="http://127.0.0.1:${PROXY_PORT}" \
    NEXUS_CONTAINER="${PROXY_CONTAINER}" \
    NEXUS_STATE_DIR="${NEXUS_STATE_DIR}" \
    NEXUS_ADMIN_PASSWORD="${NEXUS_ADMIN_PASSWORD}" \
    NEXUS_GROUP_NAME="${NEXUS_GROUP_NAME}" \
    NEXUS_INITIAL_PASSWORD="${initial_pw}" \
    SSRF_ALLOWED_IPS="${ssrf_ips}" \
    LIGHTWELL_REGISTRY_URL="${LIGHTWELL_REGISTRY_URL}" \
    UPSTREAM_REGISTRY_URL="${UPSTREAM_REGISTRY_URL}" \
    SERVICE_ACCOUNT_USERNAME="${SERVICE_ACCOUNT_USERNAME}" \
    SERVICE_ACCOUNT_PASSWORD="${SERVICE_ACCOUNT_PASSWORD}" \
      bash "${ROOT}/scripts/nexus-configure.sh"
    return
  fi

  # Sidecar on the same network — no host port / no Nexus UI on localhost.
  echo "[run] configuring Nexus via docker network sidecar"
  docker run --rm \
    --network "${NETWORK_NAME}" \
    -v "${ROOT}/scripts/nexus-configure.sh:/configure.sh:ro" \
    -e "NEXUS_BASE=http://${PROXY_DNS_NAME}:${PROXY_INTERNAL_PORT}" \
    -e "NEXUS_ADMIN_PASSWORD=${NEXUS_ADMIN_PASSWORD}" \
    -e "NEXUS_INITIAL_PASSWORD=${initial_pw}" \
    -e "NEXUS_GROUP_NAME=${NEXUS_GROUP_NAME}" \
    -e "SSRF_ALLOWED_IPS=${ssrf_ips}" \
    -e "LIGHTWELL_REGISTRY_URL=${LIGHTWELL_REGISTRY_URL}" \
    -e "UPSTREAM_REGISTRY_URL=${UPSTREAM_REGISTRY_URL}" \
    -e "SERVICE_ACCOUNT_USERNAME=${SERVICE_ACCOUNT_USERNAME}" \
    -e "SERVICE_ACCOUNT_PASSWORD=${SERVICE_ACCOUNT_PASSWORD}" \
    alpine:3.20 \
    sh -c 'apk add --no-cache bash curl jq >/dev/null && bash /configure.sh'
}

if [[ "${PROXY_IMPL}" == "nexus" ]]; then
  if [[ "${NEXUS_PUBLISH_HOST_PORT}" == "1" ]]; then
    wait_manager_http "http://127.0.0.1:${PROXY_PORT}/service/rest/v1/status" "nexus" 180 2
  else
    wait_manager_http_net "/service/rest/v1/status" "nexus" 180 2
  fi
  configure_nexus
else
  wait_manager_http "http://127.0.0.1:${PROXY_PORT}/-/ping" "custom-proxy" 150 0.2
fi

if [[ "${MODE}" == "proxy" ]]; then
  echo "[run] proxy-only mode (${PROXY_IMPL})"
  if [[ "${PROXY_IMPL}" == "nexus" ]]; then
    echo "[run] client .npmrc: registry=http://127.0.0.1:${PROXY_PORT}/repository/${NEXUS_GROUP_NAME}/"
  else
    echo "[run] client .npmrc: registry=http://127.0.0.1:${PROXY_PORT}/"
  fi
  echo "[run] (Docker network) registry=${NPM_PROXY_URL}"
  docker logs -f "${PROXY_CONTAINER}"
  exit 0
fi

TEST_ENV=(
  -e "NPM_PROXY_URL=${NPM_PROXY_URL}"
  -e "NPM_PROXY_READY_URL=${NPM_PROXY_READY_URL}"
  -e "PROXY_MISS_LOG=/tmp/npm-proxy-misses.jsonl"
)
for var in \
  ATTESTATION_OCI_PREFIX \
  ONLY_PACKAGE \
  NODE_MAJOR \
  PROVENANCE_FALLBACK_QUAY \
  PROVENANCE_CDN_RETRIES \
  PACKUMENT_COMPARE_NPMJS \
  UPSTREAM_REGISTRY_URL
do
  if [[ -n "${!var:-}" ]]; then
    TEST_ENV+=(-e "${var}")
  fi
done

echo "[run] test=${IMAGE_NAME}:${IMAGE_TAG} mode=${MODE} proxy=${NPM_PROXY_URL} impl=${PROXY_IMPL}"
docker run --rm \
  --platform "${PLATFORM}" \
  --network "${NETWORK_NAME}" \
  -v "${MISS_VOLUME}:/tmp" \
  "${TEST_ENV[@]}" \
  "${IMAGE_NAME}:${IMAGE_TAG}" \
  "${MODE}" "$@"
