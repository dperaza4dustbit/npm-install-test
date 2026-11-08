#!/usr/bin/env bash
# Run the npm-install-test container.
# Requires SERVICE_ACCOUNT_USERNAME / SERVICE_ACCOUNT_PASSWORD in the environment.
#
# Usage:
#   ./scripts/run.sh              # mode=all
#   ./scripts/run.sh functional
#   ONLY_PACKAGE=cors@2.8.6 ./scripts/run.sh functional
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# Optional local env file (gitignored)
if [[ -f "${ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi


IMAGE_NAME="${IMAGE_NAME:-npm-install-test}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
MODE="${1:-all}"
shift || true

: "${SERVICE_ACCOUNT_USERNAME:?Set SERVICE_ACCOUNT_USERNAME (Pulp read-only SA)}"
: "${SERVICE_ACCOUNT_PASSWORD:?Set SERVICE_ACCOUNT_PASSWORD (Pulp read-only SA)}"

DOCKER_ARGS=(
  --rm
  --platform "${PLATFORM}"
)
if [[ -n "${SA_ENV_FILE:-}" ]]; then
  DOCKER_ARGS+=(--env-file "${SA_ENV_FILE}")
else
  DOCKER_ARGS+=(-e SERVICE_ACCOUNT_USERNAME -e SERVICE_ACCOUNT_PASSWORD)
fi

# Optional overrides — passed through when set
for var in \
  LIGHTWELL_REGISTRY_URL \
  ATTESTATION_OCI_PREFIX \
  ONLY_PACKAGE \
  NODE_MAJOR \
  NPM_PROXY_URL \
  LIGHTWELL_AUTH_PROXY_PORT \
  PROXY_MISS_LOG \
  UPSTREAM_REGISTRY_URL \
  PROVENANCE_ALLOW_UNSIGNED
do
  if [[ -n "${!var:-}" ]]; then
    DOCKER_ARGS+=(-e "${var}")
  fi
done

echo "[run] image=${IMAGE_NAME}:${IMAGE_TAG} mode=${MODE} platform=${PLATFORM}"
exec docker run "${DOCKER_ARGS[@]}" "${IMAGE_NAME}:${IMAGE_TAG}" "${MODE}" "$@"
