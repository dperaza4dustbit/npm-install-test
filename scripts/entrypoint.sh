#!/usr/bin/env bash
# Container entrypoint. Expects SERVICE_ACCOUNT_USERNAME / SERVICE_ACCOUNT_PASSWORD.
# Starts the dual-registry proxy (Lightwell → npmjs), then runs harness modes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# shellcheck source=/dev/null
source "${ROOT}/scripts/select-node.sh"

: "${SERVICE_ACCOUNT_USERNAME:?SERVICE_ACCOUNT_USERNAME is required}"
: "${SERVICE_ACCOUNT_PASSWORD:?SERVICE_ACCOUNT_PASSWORD is required}"

export LIGHTWELL_AUTH_PROXY_PORT="${LIGHTWELL_AUTH_PROXY_PORT:-4874}"
# Harness talks to the dual-registry proxy directly (not Verdaccio).
# Verdaccio cannot safely fetch Pulp absolute tarball URLs with uplink auth.
export NPM_PROXY_URL="${NPM_PROXY_URL:-http://127.0.0.1:${LIGHTWELL_AUTH_PROXY_PORT}}"
export PROXY_MISS_LOG="${PROXY_MISS_LOG:-/tmp/npm-proxy-misses.jsonl}"
export LIGHTWELL_REGISTRY_URL="${LIGHTWELL_REGISTRY_URL:-https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated}"
export ATTESTATION_OCI_PREFIX="${ATTESTATION_OCI_PREFIX:-quay.io/redhat-user-workloads/lightwell-javascript-tenant/javascript-validated/javascript-validated-build}"

MODE="${1:-all}"
shift || true

AUTH_PID=""

cleanup() {
  [[ -n "${AUTH_PID}" ]] && kill "${AUTH_PID}" 2>/dev/null || true
}
trap cleanup EXIT

wait_http() {
  local url="$1"
  local name="$2"
  local pid="$3"
  for _ in $(seq 1 100); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[entrypoint] ${name} ready"
      return 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "[entrypoint] ${name} exited early" >&2
      return 1
    fi
    sleep 0.1
  done
  echo "[entrypoint] ${name} failed to become ready" >&2
  return 1
}

start_proxy() {
  echo "[entrypoint] starting dual-registry proxy on ${NPM_PROXY_URL}"
  node "${ROOT}/proxy/lightwell-auth-proxy.js" &
  AUTH_PID=$!
  wait_http "${NPM_PROXY_URL}/-/ping" "dual-registry-proxy" "${AUTH_PID}" || exit 1
}

run_functional() { node "${ROOT}/harness/run-functional.mjs" "$@"; }
run_binaries() { node "${ROOT}/harness/check-binaries.mjs" "$@"; }
run_install() { node "${ROOT}/harness/install-all.mjs" "$@"; }
run_provenance() { node "${ROOT}/harness/provenance.mjs" "$@"; }

# Run a suite; record pass/fail without aborting siblings (for mode=all summary).
SUITE_NAMES=()
SUITE_STATUS=()
run_suite() {
  local name="$1"
  shift
  SUITE_NAMES+=("${name}")
  echo ""
  echo "[entrypoint] >>> ${name}"
  if "$@"; then
    SUITE_STATUS+=("PASS")
    echo "[entrypoint] <<< ${name}: PASS"
  else
    SUITE_STATUS+=("FAIL")
    echo "[entrypoint] <<< ${name}: FAIL" >&2
  fi
}

print_final_summary() {
  local i fail=0
  echo ""
  echo "========== npm-install-test SUMMARY =========="
  echo "  mode: ${MODE}"
  for i in "${!SUITE_NAMES[@]}"; do
    printf '  %-12s %s\n' "${SUITE_NAMES[$i]}:" "${SUITE_STATUS[$i]}"
    [[ "${SUITE_STATUS[$i]}" == "FAIL" ]] && fail=$((fail + 1))
  done
  echo "=============================================="
  if [[ "${fail}" -gt 0 ]]; then
    echo "[entrypoint] ${fail} suite(s) failed" >&2
    return 1
  fi
  echo "[entrypoint] all suites passed"
  return 0
}

start_proxy

case "${MODE}" in
  all)
    # Continue after failures so functional + provenance tallies both appear.
    set +e
    run_suite functional run_functional
    run_suite binaries run_binaries
    run_suite install run_install
    run_suite provenance run_provenance
    set -e
    print_final_summary
    ;;
  functional)
    run_suite functional run_functional "$@"
    print_final_summary
    ;;
  binaries)
    run_suite binaries run_binaries "$@"
    print_final_summary
    ;;
  install)
    run_suite install run_install "$@"
    print_final_summary
    ;;
  provenance)
    run_suite provenance run_provenance "$@"
    print_final_summary
    ;;
  proxy)
    echo "[entrypoint] proxy-only mode; pid=${AUTH_PID}"
    echo "[entrypoint] client .npmrc: registry=${NPM_PROXY_URL}/"
    wait "${AUTH_PID}"
    ;;
  *)
    echo "usage: entrypoint.sh [all|functional|binaries|install|provenance|proxy]" >&2
    exit 2
    ;;
esac
