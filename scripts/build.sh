#!/usr/bin/env bash
# Pull Nexus manager image + build test image (and optional custom proxy image).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

IMAGE_NAME="${IMAGE_NAME:-npm-install-test}"
PROXY_IMAGE_NAME="${PROXY_IMAGE_NAME:-npm-install-proxy}"
NEXUS_IMAGE="${NEXUS_IMAGE:-sonatype/nexus3:latest}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
BUILD_CUSTOM_PROXY="${BUILD_CUSTOM_PROXY:-1}"

echo "[build] platform=${PLATFORM}"

echo "[build] nexus=${NEXUS_IMAGE} (default PROXY_IMPL=nexus)"
docker pull "${NEXUS_IMAGE}"

if [[ "${BUILD_CUSTOM_PROXY}" == "1" ]]; then
  echo "[build] custom proxy=${PROXY_IMAGE_NAME}:${IMAGE_TAG} (reference; PROXY_IMPL=custom)"
  docker build \
    --platform "${PLATFORM}" \
    -f Dockerfile.proxy \
    -t "${PROXY_IMAGE_NAME}:${IMAGE_TAG}" \
    .
fi

echo "[build] test=${IMAGE_NAME}:${IMAGE_TAG}"
docker build \
  --platform "${PLATFORM}" \
  -f Dockerfile \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  .

echo "[build] OK"
echo "[build] next: ./scripts/run.sh all"
echo "[build]      PROXY_IMPL=custom ./scripts/run.sh all   # lab-only Node proxy"
