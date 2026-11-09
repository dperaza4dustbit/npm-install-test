#!/usr/bin/env bash
# Build proxy + test images (linux/amd64 for @lightwell natives).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

IMAGE_NAME="${IMAGE_NAME:-npm-install-test}"
PROXY_IMAGE_NAME="${PROXY_IMAGE_NAME:-npm-install-proxy}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"

echo "[build] platform=${PLATFORM}"
echo "[build] proxy=${PROXY_IMAGE_NAME}:${IMAGE_TAG}"
docker build \
  --platform "${PLATFORM}" \
  -f Dockerfile.proxy \
  -t "${PROXY_IMAGE_NAME}:${IMAGE_TAG}" \
  .

echo "[build] test=${IMAGE_NAME}:${IMAGE_TAG}"
docker build \
  --platform "${PLATFORM}" \
  -f Dockerfile \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  .

echo "[build] OK"
echo "[build] next: ./scripts/run.sh all"
