#!/usr/bin/env bash
# Build the npm-install-test container image (linux/amd64 for @lightwell natives).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

IMAGE_NAME="${IMAGE_NAME:-npm-install-test}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORM="${PLATFORM:-linux/amd64}"

echo "[build] platform=${PLATFORM} image=${IMAGE_NAME}:${IMAGE_TAG}"
docker build \
  --platform "${PLATFORM}" \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  .

echo "[build] OK  docker run … ${IMAGE_NAME}:${IMAGE_TAG}"
echo "[build] next: ./scripts/run.sh all"
