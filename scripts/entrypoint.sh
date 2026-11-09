#!/usr/bin/env bash
# Test-container entrypoint. Expects an already-running dual-registry proxy
# at NPM_PROXY_URL (started by scripts/run.sh). Does not hold Pulp credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# shellcheck source=/dev/null
source "${ROOT}/scripts/select-node.sh"

export LIGHTWELL_AUTH_PROXY_PORT="${LIGHTWELL_AUTH_PROXY_PORT:-4874}"
export NPM_PROXY_URL="${NPM_PROXY_URL:-http://npm-install-proxy:${LIGHTWELL_AUTH_PROXY_PORT}}"
export PROXY_MISS_LOG="${PROXY_MISS_LOG:-/tmp/npm-proxy-misses.jsonl}"
export ATTESTATION_OCI_PREFIX="${ATTESTATION_OCI_PREFIX:-quay.io/redhat-user-workloads/lightwell-javascript-tenant/javascript-validated/javascript-validated-build}"

MODE="${1:-all}"
shift || true

wait_http() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 100); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[entrypoint] ${name} ready at ${url}"
      return 0
    fi
    sleep 0.1
  done
  echo "[entrypoint] ${name} not reachable at ${url}" >&2
  return 1
}

run_functional() { node "${ROOT}/harness/run-functional.mjs" "$@"; }
run_binaries() { node "${ROOT}/harness/check-binaries.mjs" "$@"; }
run_install() { node "${ROOT}/harness/install-all.mjs" "$@"; }
run_provenance() { node "${ROOT}/harness/provenance.mjs" "$@"; }

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
  echo "  proxy: ${NPM_PROXY_URL}"
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

echo "[entrypoint] waiting for dual-registry proxy ${NPM_PROXY_URL}"
wait_http "${NPM_PROXY_URL}/-/ping" "dual-registry-proxy" || exit 1

case "${MODE}" in
  all)
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
  *)
    echo "usage: entrypoint.sh [all|functional|binaries|install|provenance]" >&2
    echo "  (proxy runs in a separate container — see ./scripts/run.sh)" >&2
    exit 2
    ;;
esac
