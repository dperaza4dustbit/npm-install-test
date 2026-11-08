#!/usr/bin/env bash
# Prefer Node 22; switch to Node 20 when requested (NODE_MAJOR=20).
set -euo pipefail

MAJOR="${NODE_MAJOR:-22}"
case "${MAJOR}" in
  20)
    export PATH="/usr/local/lib/nodejs/node20/bin:${PATH}"
    ;;
  22|*)
    export PATH="/usr/local/lib/nodejs/node22/bin:${PATH}"
    ;;
esac

echo "[select-node] using Node $(node -v) (requested major=${MAJOR})" >&2
