#!/usr/bin/env bash
# Provision Nexus npm dual-registry after the container is running.
# Creates npm-lightwell + npm-npmjs proxies and npm-group (Lightwell first).
# Idempotent: safe to re-run against an existing Nexus data volume.
#
# Auth: NEXUS_CONTAINER (docker exec admin.password) and/or NEXUS_INITIAL_PASSWORD.
# When run from a sidecar on the Docker network, pass NEXUS_INITIAL_PASSWORD and
# optional SSRF_ALLOWED_IPS (space/newline-separated) so dig/docker are not required.
set -euo pipefail

NX_BASE="${NEXUS_BASE:?NEXUS_BASE required (e.g. http://127.0.0.1:8081)}"
NX_CONTAINER="${NEXUS_CONTAINER:-}"
: "${SERVICE_ACCOUNT_USERNAME:?}"
: "${SERVICE_ACCOUNT_PASSWORD:?}"
LIGHTWELL_REGISTRY_URL="${LIGHTWELL_REGISTRY_URL:-https://packages.redhat.com/api/pulp-content/lightwell/javascript/validated}"
UPSTREAM_REGISTRY_URL="${UPSTREAM_REGISTRY_URL:-https://registry.npmjs.org}"
NEXUS_ADMIN_PASSWORD="${NEXUS_ADMIN_PASSWORD:-Password1!}"
NEXUS_GROUP_NAME="${NEXUS_GROUP_NAME:-npm-group}"
NEXUS_LIGHTWELL_NAME="${NEXUS_LIGHTWELL_NAME:-npm-lightwell}"
NEXUS_NPMJS_NAME="${NEXUS_NPMJS_NAME:-npm-npmjs}"
STATE_DIR="${NEXUS_STATE_DIR:-}"
# contentMaxAge 0: never serve stale proxy blobs (avoids EINTEGRITY after prefer flips).
CONTENT_MAX_AGE="${NEXUS_CONTENT_MAX_AGE:-0}"
METADATA_MAX_AGE="${NEXUS_METADATA_MAX_AGE:-0}"

auth_ok() {
  local user="$1" pass="$2"
  local code
  code="$(curl -sS -u "${user}:${pass}" -o /dev/null -w "%{http_code}" \
    "${NX_BASE}/service/rest/v1/status" || true)"
  [[ "${code}" == "200" ]]
}

echo "[nexus-configure] base=${NX_BASE} container=${NX_CONTAINER:-"(none)"}"

# Resolve admin credentials: first-boot file inside the container, or known password.
ADMIN_USER="admin"
ADMIN_PASS=""
if auth_ok admin "${NEXUS_ADMIN_PASSWORD}"; then
  ADMIN_PASS="${NEXUS_ADMIN_PASSWORD}"
  echo "[nexus-configure] admin auth with configured password"
else
  INITIAL_PW="${NEXUS_INITIAL_PASSWORD:-}"
  if [[ -z "${INITIAL_PW}" && -n "${NX_CONTAINER}" ]]; then
    INITIAL_PW="$(docker exec "${NX_CONTAINER}" cat /nexus-data/admin.password 2>/dev/null || true)"
  fi
  if [[ -n "${INITIAL_PW}" ]] && auth_ok admin "${INITIAL_PW}"; then
    echo "[nexus-configure] changing initial admin password..."
    code="$(curl -sS -u "admin:${INITIAL_PW}" -o /tmp/nx-pw.json -w "%{http_code}" \
      -X PUT -H "Content-Type: text/plain" \
      "${NX_BASE}/service/rest/v1/security/users/admin/change-password" \
      --data-binary "${NEXUS_ADMIN_PASSWORD}" || true)"
    if [[ "${code}" != "204" && "${code}" != "200" ]]; then
      echo "[nexus-configure] change-password HTTP ${code}" >&2
      head -c 400 /tmp/nx-pw.json >&2 || true
      echo >&2
      exit 1
    fi
    ADMIN_PASS="${NEXUS_ADMIN_PASSWORD}"
  else
    echo "[nexus-configure] cannot authenticate as admin" >&2
    exit 1
  fi
fi

if [[ -n "${STATE_DIR}" ]]; then
  mkdir -p "${STATE_DIR}"
  printf "%s" "${ADMIN_PASS}" >"${STATE_DIR}/admin.password"
  chmod 600 "${STATE_DIR}/admin.password"
fi

AUTH="admin:${ADMIN_PASS}"

# Accept Community EULA (required before repository content is served).
eula_json="$(curl -fsS -u "${AUTH}" "${NX_BASE}/service/rest/v1/system/eula")"
if echo "${eula_json}" | jq -e '.accepted == true' >/dev/null 2>&1; then
  echo "[nexus-configure] EULA already accepted"
else
  echo "[nexus-configure] accepting EULA..."
  jq '{accepted:true, disclaimer:.disclaimer}' <<<"${eula_json}" >/tmp/nx-eula-post.json
  code="$(curl -sS -u "${AUTH}" -o /tmp/nx-eula-resp.json -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    "${NX_BASE}/service/rest/v1/system/eula" \
    --data-binary @/tmp/nx-eula-post.json)"
  [[ "${code}" == "204" || "${code}" == "200" ]] || {
    echo "[nexus-configure] EULA HTTP ${code}" >&2
    head -c 400 /tmp/nx-eula-resp.json >&2 || true
    exit 1
  }
fi

# SSRF allowlist for Lightwell host (may resolve to RFC1918 on corp networks).
lw_host="$(echo "${LIGHTWELL_REGISTRY_URL}" | sed -E 's|^https?://([^/:]+).*|\1|')"

if [[ -n "${lw_host}" ]]; then
  if [[ -n "${SSRF_ALLOWED_IPS:-}" ]]; then
    lw_ips="${SSRF_ALLOWED_IPS}"
  else
    lw_ips="$(getent ahostsv4 "${lw_host}" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    if [[ -z "${lw_ips}" ]]; then
      lw_ips="$(dig +short A "${lw_host}" 2>/dev/null | sort -u || true)"
    fi
  fi
  ips_json="$(printf '%s\n' ${lw_ips} | jq -R . | jq -s 'map(select(length>0))')"
  echo "[nexus-configure] SSRF allow ${lw_host} ips=${ips_json}"
  jq -n \
    --arg host "${lw_host}" \
    --argjson ips "${ips_json}" \
    '{enabled:true, allowedIPs:$ips, allowedDomains:[$host]}' >/tmp/nx-ssrf.json
  curl -fsS -u "${AUTH}" -X PUT -H "Content-Type: application/json" \
    "${NX_BASE}/service/rest/v1/security/ssrf-protection" \
    --data-binary @/tmp/nx-ssrf.json >/dev/null
fi

# Anonymous read so the test container needs no Nexus credentials.
curl -fsS -u "${AUTH}" -X PUT -H "Content-Type: application/json" \
  "${NX_BASE}/service/rest/v1/security/anonymous" \
  -d '{"enabled":true,"userId":"anonymous","realmName":"NexusAuthorizingRealm"}' >/dev/null \
  || true

create_npm_proxy() {
  local name="$1" remote_url="$2" with_auth="$3"
  local body_file="/tmp/nx-body-${name}.json"
  # autoBlock false: a transient Lightwell timeout must not flip prefer to npmjs-only.
  if [[ "${with_auth}" == "1" ]]; then
    jq -n \
      --arg name "${name}" \
      --arg url "${remote_url}" \
      --arg user "${SERVICE_ACCOUNT_USERNAME}" \
      --arg pass "${SERVICE_ACCOUNT_PASSWORD}" \
      --argjson cmax "${CONTENT_MAX_AGE}" \
      --argjson mmax "${METADATA_MAX_AGE}" \
      '{
        name: $name,
        online: true,
        storage: { blobStoreName: "default", strictContentTypeValidation: true },
        cleanup: null,
        proxy: { remoteUrl: $url, contentMaxAge: $cmax, metadataMaxAge: $mmax },
        negativeCache: { enabled: true, timeToLive: 0 },
        httpClient: {
          blocked: false,
          autoBlock: false,
          connection: { timeout: 180, retries: 2 },
          authentication: { type: "username", username: $user, password: $pass }
        },
        routingRuleName: null,
        npm: { removeNonCataloged: false, removeQuarantinedVersions: false }
      }' >"${body_file}"
  else
    jq -n \
      --arg name "${name}" \
      --arg url "${remote_url}" \
      --argjson cmax "${CONTENT_MAX_AGE}" \
      --argjson mmax "${METADATA_MAX_AGE}" \
      '{
        name: $name,
        online: true,
        storage: { blobStoreName: "default", strictContentTypeValidation: true },
        cleanup: null,
        proxy: { remoteUrl: $url, contentMaxAge: $cmax, metadataMaxAge: $mmax },
        negativeCache: { enabled: true, timeToLive: 0 },
        httpClient: {
          blocked: false,
          autoBlock: false,
          connection: { timeout: 180, retries: 2 }
        },
        routingRuleName: null,
        npm: { removeNonCataloged: false, removeQuarantinedVersions: false }
      }' >"${body_file}"
  fi

  local code
  code="$(curl -sS -u "${AUTH}" -o "/tmp/nx-${name}.json" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    "${NX_BASE}/service/rest/v1/repositories/npm/proxy" \
    --data-binary @"${body_file}")"
  if [[ "${code}" == "201" || "${code}" == "204" ]]; then
    echo "[nexus-configure] created proxy ${name}"
    return 0
  fi
  code="$(curl -sS -u "${AUTH}" -o "/tmp/nx-${name}-put.json" -w "%{http_code}" \
    -X PUT -H "Content-Type: application/json" \
    "${NX_BASE}/service/rest/v1/repositories/npm/proxy/${name}" \
    --data-binary @"${body_file}")"
  if [[ "${code}" == "204" || "${code}" == "200" ]]; then
    echo "[nexus-configure] updated proxy ${name}"
    return 0
  fi
  echo "[nexus-configure] proxy ${name} failed POST/PUT" >&2
  head -c 500 "/tmp/nx-${name}.json" >&2 || true
  echo >&2
  head -c 500 "/tmp/nx-${name}-put.json" >&2 || true
  echo >&2
  return 1
}

create_npm_group() {
  local body_file="/tmp/nx-body-group.json"
  jq -n \
    --arg name "${NEXUS_GROUP_NAME}" \
    --arg lw "${NEXUS_LIGHTWELL_NAME}" \
    --arg npmjs "${NEXUS_NPMJS_NAME}" \
    '{
      name: $name,
      online: true,
      storage: { blobStoreName: "default", strictContentTypeValidation: true },
      group: { memberNames: [$lw, $npmjs] }
    }' >"${body_file}"

  local code
  code="$(curl -sS -u "${AUTH}" -o /tmp/nx-group.json -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    "${NX_BASE}/service/rest/v1/repositories/npm/group" \
    --data-binary @"${body_file}")"
  if [[ "${code}" == "201" || "${code}" == "204" ]]; then
    echo "[nexus-configure] created group ${NEXUS_GROUP_NAME}"
    return 0
  fi
  code="$(curl -sS -u "${AUTH}" -o /tmp/nx-group-put.json -w "%{http_code}" \
    -X PUT -H "Content-Type: application/json" \
    "${NX_BASE}/service/rest/v1/repositories/npm/group/${NEXUS_GROUP_NAME}" \
    --data-binary @"${body_file}")"
  if [[ "${code}" == "204" || "${code}" == "200" ]]; then
    echo "[nexus-configure] updated group ${NEXUS_GROUP_NAME}"
    return 0
  fi
  echo "[nexus-configure] group ${NEXUS_GROUP_NAME} failed" >&2
  head -c 500 /tmp/nx-group.json >&2 || true
  echo >&2
  return 1
}

invalidate_repo_cache() {
  local name="$1"
  local code
  code="$(curl -sS -u "${AUTH}" -o /tmp/nx-inv.json -w "%{http_code}" \
    -X POST "${NX_BASE}/service/rest/v1/repositories/${name}/invalidate-cache" || true)"
  if [[ "${code}" == "204" || "${code}" == "200" ]]; then
    echo "[nexus-configure] invalidated cache ${name}"
  else
    echo "[nexus-configure] invalidate-cache ${name} HTTP ${code} (continuing)" >&2
  fi
}

# Delete stored proxy components so packument integrity and tarball bytes re-fetch together.
purge_repo_components() {
  local repo="$1"
  local rounds=0
  echo "[nexus-configure] purging cached components in ${repo}"
  while (( rounds < 50 )); do
    rounds=$((rounds + 1))
    curl -fsS -u "${AUTH}" \
      "${NX_BASE}/service/rest/v1/components?repository=${repo}" >/tmp/nx-comps.json
    local ids
    ids="$(jq -r '.items[].id // empty' /tmp/nx-comps.json)"
    if [[ -z "${ids}" ]]; then
      echo "[nexus-configure] ${repo} cache empty"
      return 0
    fi
    local n=0
    while read -r id; do
      [[ -z "${id}" ]] && continue
      curl -sS -u "${AUTH}" -o /dev/null -w "" \
        -X DELETE "${NX_BASE}/service/rest/v1/components/${id}" || true
      n=$((n + 1))
    done <<<"${ids}"
    echo "[nexus-configure] deleted ${n} component(s) from ${repo} (round ${rounds})"
  done
  echo "[nexus-configure] purge stopped after ${rounds} rounds for ${repo}" >&2
}

create_npm_proxy "${NEXUS_LIGHTWELL_NAME}" "${LIGHTWELL_REGISTRY_URL}" 1
create_npm_proxy "${NEXUS_NPMJS_NAME}" "${UPSTREAM_REGISTRY_URL}" 0
create_npm_group

invalidate_repo_cache "${NEXUS_LIGHTWELL_NAME}"
invalidate_repo_cache "${NEXUS_NPMJS_NAME}"
invalidate_repo_cache "${NEXUS_GROUP_NAME}"
purge_repo_components "${NEXUS_LIGHTWELL_NAME}"
purge_repo_components "${NEXUS_NPMJS_NAME}"

GROUP_URL="${NX_BASE}/repository/${NEXUS_GROUP_NAME}"
echo "[nexus-configure] verifying group ${GROUP_URL}/accepts ..."
# Anonymous (or admin) packument fetch proves content path + EULA.
code="$(curl -sS -o /tmp/nx-accepts.json -w "%{http_code}" "${GROUP_URL}/accepts" || true)"
if [[ "${code}" != "200" ]]; then
  code="$(curl -sS -u "${AUTH}" -o /tmp/nx-accepts.json -w "%{http_code}" "${GROUP_URL}/accepts" || true)"
fi
if [[ "${code}" != "200" ]]; then
  echo "[nexus-configure] group packument HTTP ${code}" >&2
  head -c 400 /tmp/nx-accepts.json >&2 || true
  echo >&2
  exit 1
fi
echo "[nexus-configure] OK group=${GROUP_URL}"
