#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${REPOSITORY_ROOT}"

REMOTE_HOST="${ATLAS_HOST:-}"
REMOTE_USER="${ATLAS_USER:-root}"
REMOTE_DIR="${ATLAS_DIR:-/opt/atlas-v2}"
REMOTE_BACKUP_ROOT="${ATLAS_BACKUP_ROOT:-/var/backups/atlas-v2}"
ENV_FILE_INPUT="${ATLAS_ENV_FILE:-}"
SSH_KEY="${ATLAS_SSH_KEY:-}"
COORDINATOR_PATH="${ATLAS_COORDINATOR_PATH:-/usr/local/sbin/atlas-v2-deployment-coordinator}"
GUARDIAN_UNIT_PATH="${ATLAS_GUARDIAN_UNIT_PATH:-/etc/systemd/system/atlas-v2-deployment-guardian.service}"
COORDINATOR_STATE_FILE="${ATLAS_COORDINATOR_STATE_FILE:-/var/lib/atlas-v2-deployment/active.state}"
COORDINATOR_STAGE="${ATLAS_COORDINATOR_STAGE:-/var/lib/atlas-v2-deployment/staging}"
COORDINATOR_INSTALL_LOCK="${ATLAS_COORDINATOR_INSTALL_LOCK:-/run/lock/atlas-v2-deployment-install.lock}"
BACKUP_TOOL_PATH="${ATLAS_BACKUP_TOOL_PATH:-/usr/local/libexec/atlas-v2/backup.sh}"
RESTORE_TOOL_PATH="${ATLAS_RESTORE_TOOL_PATH:-/usr/local/libexec/atlas-v2/restore-test.sh}"
ROLE_INITIALIZER_PATH="${ATLAS_ROLE_INITIALIZER_PATH:-/usr/local/libexec/atlas-v2/init-roles.sh}"
CADDY_CONFIG_PATH="${ATLAS_CADDY_CONFIG_PATH:-/usr/local/libexec/atlas-v2/Caddyfile}"
LEASE_SECONDS="${ATLAS_DEPLOYMENT_LEASE_SECONDS:-900}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSYNC_RSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

fail() {
  echo "Atlas V2 deployment refused: $*" >&2
  exit 1
}

valid_path() {
  local value="$1"
  [[ "${value}" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "${value}" != "/" && "${value}" != *"//"* ]] || return 1
  [[ "/${value#/}/" != *"/../"* && "/${value#/}/" != *"/./"* ]]
}

path_is_equal_or_descendant() {
  [[ "$1" == "$2" || "$1" == "$2/"* ]]
}

[[ -n "${REMOTE_HOST}" ]] || fail "set ATLAS_HOST to the target VPS hostname or IP."
[[ "${REMOTE_HOST}" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "ATLAS_HOST contains unsupported characters."
[[ "${REMOTE_USER}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "ATLAS_USER contains unsupported characters."
valid_path "${REMOTE_DIR}" || fail "ATLAS_DIR must be a canonical absolute path with supported characters."
valid_path "${REMOTE_BACKUP_ROOT}" || fail "ATLAS_BACKUP_ROOT must be a canonical absolute path with supported characters."
valid_path "${COORDINATOR_PATH}" || fail "ATLAS_COORDINATOR_PATH must be a canonical absolute path."
valid_path "${GUARDIAN_UNIT_PATH}" || fail "ATLAS_GUARDIAN_UNIT_PATH must be a canonical absolute path."
valid_path "${COORDINATOR_STATE_FILE}" || fail "ATLAS_COORDINATOR_STATE_FILE must be a canonical absolute path."
valid_path "${COORDINATOR_STAGE}" || fail "ATLAS_COORDINATOR_STAGE must be a canonical absolute path."
valid_path "${COORDINATOR_INSTALL_LOCK}" || fail "ATLAS_COORDINATOR_INSTALL_LOCK must be a canonical absolute path."
valid_path "${BACKUP_TOOL_PATH}" || fail "ATLAS_BACKUP_TOOL_PATH must be a canonical absolute path."
valid_path "${RESTORE_TOOL_PATH}" || fail "ATLAS_RESTORE_TOOL_PATH must be a canonical absolute path."
valid_path "${ROLE_INITIALIZER_PATH}" || fail "ATLAS_ROLE_INITIALIZER_PATH must be a canonical absolute path."
valid_path "${CADDY_CONFIG_PATH}" || fail "ATLAS_CADDY_CONFIG_PATH must be a canonical absolute path."
path_is_equal_or_descendant "${REMOTE_BACKUP_ROOT}" "${REMOTE_DIR}" \
  && fail "ATLAS_BACKUP_ROOT must be outside the synchronized ATLAS_DIR tree."
[[ "${LEASE_SECONDS}" =~ ^[0-9]+$ && "${LEASE_SECONDS}" -ge 2 && "${LEASE_SECONDS}" -le 900 ]] \
  || fail "ATLAS_DEPLOYMENT_LEASE_SECONDS must be between 2 and 900 seconds."
if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" != "1" ]]; then
  [[ "${REMOTE_USER}" == "root" ]] || fail "ATLAS_USER must be root for the supported root-admin deployment model."
  [[ "${REMOTE_DIR}" == "/opt/atlas-v2" ]] || fail "ATLAS_DIR must be /opt/atlas-v2 for the supported operator model."
  [[ "${REMOTE_BACKUP_ROOT}" == "/var/backups/atlas-v2" ]] || fail "ATLAS_BACKUP_ROOT must be /var/backups/atlas-v2 for the supported operator model."
  [[ "${COORDINATOR_PATH}" == "/usr/local/sbin/atlas-v2-deployment-coordinator" ]] \
    || fail "ATLAS_COORDINATOR_PATH must use the bootstrap-installed coordinator."
  [[ "${GUARDIAN_UNIT_PATH}" == "/etc/systemd/system/atlas-v2-deployment-guardian.service" ]] \
    || fail "ATLAS_GUARDIAN_UNIT_PATH must use the bootstrap-installed unit."
  [[ "${COORDINATOR_STAGE}" == "/var/lib/atlas-v2-deployment/staging" ]] \
    || fail "ATLAS_COORDINATOR_STAGE must use the root-owned staging directory."
  [[ "${COORDINATOR_INSTALL_LOCK}" == "/run/lock/atlas-v2-deployment-install.lock" ]] \
    || fail "ATLAS_COORDINATOR_INSTALL_LOCK must use the root-owned acquisition lock."
  [[ "${BACKUP_TOOL_PATH}" == "/usr/local/libexec/atlas-v2/backup.sh" ]] \
    || fail "ATLAS_BACKUP_TOOL_PATH must use the immutable root-owned tool path."
  [[ "${RESTORE_TOOL_PATH}" == "/usr/local/libexec/atlas-v2/restore-test.sh" ]] \
    || fail "ATLAS_RESTORE_TOOL_PATH must use the immutable root-owned tool path."
  [[ "${ROLE_INITIALIZER_PATH}" == "/usr/local/libexec/atlas-v2/init-roles.sh" ]] \
    || fail "ATLAS_ROLE_INITIALIZER_PATH must use the immutable root-owned tool path."
  [[ "${CADDY_CONFIG_PATH}" == "/usr/local/libexec/atlas-v2/Caddyfile" ]] \
    || fail "ATLAS_CADDY_CONFIG_PATH must use the immutable root-owned configuration path."
fi

[[ -n "${ENV_FILE_INPUT}" ]] || fail "set ATLAS_ENV_FILE to the production environment file."
[[ -f "${ENV_FILE_INPUT}" ]] || fail "production environment file is not a regular file: ${ENV_FILE_INPUT}"
command -v realpath >/dev/null 2>&1 || fail "required local command is unavailable: realpath"
ENV_FILE="$(realpath "${ENV_FILE_INPUT}")"
[[ -f "${ENV_FILE}" ]] || fail "canonical production environment path is not a regular file: ${ENV_FILE}"
grep -q "REPLACE_WITH" "${ENV_FILE}" \
  && fail "production environment file still contains REPLACE_WITH placeholders."

for required_key in \
  POSTGRES_BOOTSTRAP_PASSWORD \
  ATLAS_MIGRATOR_PASSWORD \
  ATLAS_WEB_PASSWORD \
  ATLAS_WORKER_PASSWORD \
  SESSION_SECRET \
  ATLAS_ORIGIN \
  AUTH_MODE \
  GOOGLE_CLIENT_ID \
  GOOGLE_CLIENT_SECRET \
  GOOGLE_REDIRECT_URI; do
  grep -Eq "^${required_key}=.+$" "${ENV_FILE}" \
    || fail "production environment file is missing ${required_key}."
done

password_keys=(
  POSTGRES_BOOTSTRAP_PASSWORD
  ATLAS_MIGRATOR_PASSWORD
  ATLAS_WEB_PASSWORD
  ATLAS_WORKER_PASSWORD
)
database_passwords=()
for password_key in "${password_keys[@]}"; do
  password_count="$(grep -Ec "^${password_key}=" "${ENV_FILE}")"
  [[ "${password_count}" -eq 1 ]] \
    || fail "production environment must contain ${password_key} exactly once."
  password_value="$(sed -n "s/^${password_key}=//p" "${ENV_FILE}")"
  [[ "${password_value}" =~ ^[A-Za-z0-9_-]{24,128}$ ]] \
    || fail "${password_key} must be a 24-128 character URL-safe credential using only letters, numbers, underscore, or hyphen."
  database_passwords+=("${password_value}")
done
for ((password_index = 0; password_index < ${#password_keys[@]}; password_index += 1)); do
  for ((other_index = password_index + 1; other_index < ${#password_keys[@]}; other_index += 1)); do
    [[ "${database_passwords[password_index]}" != "${database_passwords[other_index]}" ]] \
      || fail "Atlas database role credentials must be pairwise distinct."
  done
done
unset password_value database_passwords

grep -Fxq 'NODE_ENV=production' "${ENV_FILE}" \
  || fail "production environment must set NODE_ENV=production."
grep -Fxq 'AUTH_MODE=google' "${ENV_FILE}" \
  || fail "production environment must set AUTH_MODE=google."
grep -Eq '^ATLAS_ORIGIN=https://[^/]+$' "${ENV_FILE}" \
  || fail "ATLAS_ORIGIN must be an HTTPS origin without a path."
grep -Eq '^GOOGLE_REDIRECT_URI=https://[^/]+/api/auth/google/callback$' "${ENV_FILE}" \
  || fail "GOOGLE_REDIRECT_URI must be the HTTPS Atlas callback URL."
ATLAS_ORIGIN_VALUE="$(sed -n 's/^ATLAS_ORIGIN=//p' "${ENV_FILE}")"
GOOGLE_REDIRECT_URI_VALUE="$(sed -n 's/^GOOGLE_REDIRECT_URI=//p' "${ENV_FILE}")"
[[ "${GOOGLE_REDIRECT_URI_VALUE}" == "${ATLAS_ORIGIN_VALUE}/api/auth/google/callback" ]] \
  || fail "GOOGLE_REDIRECT_URI must use the exact ATLAS_ORIGIN."

ENV_SOURCE_EXCLUDE=""
case "${ENV_FILE}" in
  "${REPOSITORY_ROOT}"/*) ENV_SOURCE_EXCLUDE="/${ENV_FILE#"${REPOSITORY_ROOT}/"}" ;;
esac

if [[ -n "${SSH_KEY}" ]]; then
  [[ -f "${SSH_KEY}" ]] || fail "SSH key not found: ${SSH_KEY}"
  SSH_OPTS+=(-i "${SSH_KEY}")
  printf -v RSYNC_RSH '%s -i %q' "${RSYNC_RSH}" "${SSH_KEY}"
fi

for command_name in git npm npx rsync ssh curl node mktemp install; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required local command is unavailable: ${command_name}"
done

git diff --quiet || fail "commit or stash tracked working-tree changes before deployment."
git diff --cached --quiet || fail "commit or unstage staged changes before deployment."
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] \
  || fail "commit or remove untracked release files before deployment."
LOCAL_COMMIT="$(git rev-parse --verify HEAD)"
[[ "${LOCAL_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve the release Git commit."

npm test
npm run typecheck
npm run build
npx --yes @redocly/cli lint openapi/atlas-v2.yaml

REMOTE_TARGET="${REMOTE_USER}@${REMOTE_HOST}"
DEPLOYMENT_TOKEN="$(node --input-type=module -e 'console.log(crypto.randomUUID())')"
[[ "${DEPLOYMENT_TOKEN}" =~ ^[0-9a-f-]{36}$ ]] || fail "could not create a deployment token."
REMOTE_CANDIDATE_STAGE="${COORDINATOR_STAGE}/${DEPLOYMENT_TOKEN}"

ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- "${ATLAS_COORDINATOR_TEST_MODE:-0}" <<'REMOTE_ROOT_PREFLIGHT'
set -euo pipefail
test_mode="$1"
if [[ "${test_mode}" != "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || { echo "Atlas deployment requires a root SSH administrator." >&2; exit 1; }
fi
REMOTE_ROOT_PREFLIGHT

COORDINATOR_SOURCE="${REPOSITORY_ROOT}/deploy/deployment-coordinator.sh"
GUARDIAN_UNIT_SOURCE="${REPOSITORY_ROOT}/deploy/systemd/atlas-v2-deployment-guardian.service"
BACKUP_SOURCE="${REPOSITORY_ROOT}/deploy/backup.sh"
RESTORE_SOURCE="${REPOSITORY_ROOT}/deploy/restore-test.sh"
ROLE_INITIALIZER_SOURCE="${REPOSITORY_ROOT}/deploy/postgres/init-roles.sh"
CADDY_CONFIG_SOURCE="${REPOSITORY_ROOT}/deploy/Caddyfile"
[[ -f "${COORDINATOR_SOURCE}" && ! -L "${COORDINATOR_SOURCE}" ]] \
  || fail "reviewed deployment coordinator source is unavailable."
[[ -f "${GUARDIAN_UNIT_SOURCE}" && ! -L "${GUARDIAN_UNIT_SOURCE}" ]] \
  || fail "reviewed deployment guardian unit source is unavailable."
[[ -f "${BACKUP_SOURCE}" && ! -L "${BACKUP_SOURCE}" ]] \
  || fail "reviewed backup source is unavailable."
[[ -f "${RESTORE_SOURCE}" && ! -L "${RESTORE_SOURCE}" ]] \
  || fail "reviewed restore-test source is unavailable."
[[ -f "${ROLE_INITIALIZER_SOURCE}" && ! -L "${ROLE_INITIALIZER_SOURCE}" ]] \
  || fail "reviewed database-role initializer source is unavailable."
[[ -f "${CADDY_CONFIG_SOURCE}" && ! -L "${CADDY_CONFIG_SOURCE}" ]] \
  || fail "reviewed Caddy configuration source is unavailable."
COORDINATOR_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${COORDINATOR_SOURCE}")"
GUARDIAN_UNIT_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${GUARDIAN_UNIT_SOURCE}")"
BACKUP_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${BACKUP_SOURCE}")"
RESTORE_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${RESTORE_SOURCE}")"
ROLE_INITIALIZER_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${ROLE_INITIALIZER_SOURCE}")"
CADDY_CONFIG_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${CADDY_CONFIG_SOURCE}")"
[[ "${COORDINATOR_SHA256}" =~ ^[0-9a-f]{64}$ && "${GUARDIAN_UNIT_SHA256}" =~ ^[0-9a-f]{64}$ \
  && "${BACKUP_SHA256}" =~ ^[0-9a-f]{64}$ && "${RESTORE_SHA256}" =~ ^[0-9a-f]{64}$ \
  && "${ROLE_INITIALIZER_SHA256}" =~ ^[0-9a-f]{64}$ && "${CADDY_CONFIG_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "could not hash reviewed coordinator assets."

LOCAL_CANDIDATE_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/atlas-v2-candidate.XXXXXX")"
cleanup_local_candidate() {
  local cleanup_status="$?"
  trap - EXIT INT TERM
  case "${LOCAL_CANDIDATE_STAGE:-}" in
    "${TMPDIR:-/tmp}"/atlas-v2-candidate.*) /bin/rm -rf -- "${LOCAL_CANDIDATE_STAGE}" ;;
  esac
  exit "${cleanup_status}"
}
trap cleanup_local_candidate EXIT INT TERM
git archive --format=tar --output="${LOCAL_CANDIDATE_STAGE}/atlas-release.tar" "${LOCAL_COMMIT}"
install -m 0600 "${ENV_FILE}" "${LOCAL_CANDIDATE_STAGE}/atlas.env"
RELEASE_ARCHIVE_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${LOCAL_CANDIDATE_STAGE}/atlas-release.tar")"
ENVIRONMENT_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${LOCAL_CANDIDATE_STAGE}/atlas.env")"
[[ "${RELEASE_ARCHIVE_SHA256}" =~ ^[0-9a-f]{64}$ && "${ENVIRONMENT_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "could not hash immutable release inputs."

install_verified_coordinator_and_begin() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${COORDINATOR_STAGE}" "${REMOTE_CANDIDATE_STAGE}" "${ATLAS_COORDINATOR_TEST_MODE:-0}" \
    <<'REMOTE_STAGE' || fail "remote immutable staging directory preparation failed."
set -euo pipefail
stage_root="$1"
stage="$2"
test_mode="$3"
if [[ "${test_mode}" == "1" ]]; then
  install -d -m 0700 -- "${stage_root}" "${stage}"
else
  [[ "$(id -u)" -eq 0 ]] || exit 1
  [[ "${stage_root}" == "/var/lib/atlas-v2-deployment/staging" ]] || exit 1
  [[ "${stage}" == "${stage_root}/"* ]] || exit 1
  [[ -d "${stage_root}" && ! -L "${stage_root}" ]] || exit 1
  [[ "$(stat -c '%U:%G:%a' "${stage_root}")" == "root:root:700" ]] || exit 1
  install -o root -g root -m 0700 -d -- "${stage}"
fi
REMOTE_STAGE

  rsync -az --chmod=F600 -e "${RSYNC_RSH}" \
    "${COORDINATOR_SOURCE}" "${GUARDIAN_UNIT_SOURCE}" "${BACKUP_SOURCE}" "${RESTORE_SOURCE}" \
    "${ROLE_INITIALIZER_SOURCE}" "${CADDY_CONFIG_SOURCE}" \
    "${LOCAL_CANDIDATE_STAGE}/atlas-release.tar" "${LOCAL_CANDIDATE_STAGE}/atlas.env" \
    "${REMOTE_TARGET}:${REMOTE_CANDIDATE_STAGE}/" \
    || fail "immutable deployment bundle staging failed."

  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${REMOTE_CANDIDATE_STAGE}" "${COORDINATOR_PATH}" "${GUARDIAN_UNIT_PATH}" \
    "${BACKUP_TOOL_PATH}" "${RESTORE_TOOL_PATH}" "${ROLE_INITIALIZER_PATH}" "${CADDY_CONFIG_PATH}" \
    "${COORDINATOR_STATE_FILE}" \
    "${COORDINATOR_INSTALL_LOCK}" "${COORDINATOR_SHA256}" "${GUARDIAN_UNIT_SHA256}" \
    "${BACKUP_SHA256}" "${RESTORE_SHA256}" "${ROLE_INITIALIZER_SHA256}" "${CADDY_CONFIG_SHA256}" \
    "${RELEASE_ARCHIVE_SHA256}" \
    "${ENVIRONMENT_SHA256}" "${DEPLOYMENT_TOKEN}" "${REMOTE_DIR}" \
    "${REMOTE_BACKUP_ROOT}" "${LEASE_SECONDS}" "${LOCAL_COMMIT}" \
    "${ATLAS_COORDINATOR_TEST_MODE:-0}" \
    <<'REMOTE_INSTALL' || fail "immutable deployment bundle install or ownership acquisition failed."
set -euo pipefail
stage="$1"
coordinator="$2"
unit="$3"
backup_tool="$4"
restore_tool="$5"
role_initializer="$6"
caddy_config="$7"
state_file="$8"
install_lock="$9"
expected_coordinator_hash="${10}"
expected_unit_hash="${11}"
expected_backup_hash="${12}"
expected_restore_hash="${13}"
expected_role_initializer_hash="${14}"
expected_caddy_config_hash="${15}"
expected_archive_hash="${16}"
expected_environment_hash="${17}"
deployment_token="${18}"
remote_dir="${19}"
backup_root="${20}"
lease_seconds="${21}"
bundle_version="${22}"
test_mode="${23}"
staged_coordinator="${stage}/deployment-coordinator.sh"
staged_unit="${stage}/atlas-v2-deployment-guardian.service"
staged_backup="${stage}/backup.sh"
staged_restore="${stage}/restore-test.sh"
staged_role_initializer="${stage}/init-roles.sh"
staged_caddy_config="${stage}/Caddyfile"
staged_archive="${stage}/atlas-release.tar"
staged_environment="${stage}/atlas.env"
coordinator_next="${coordinator}.next"
unit_next="${unit}.next"
backup_next="${backup_tool}.next"
restore_next="${restore_tool}.next"
role_initializer_next="${role_initializer}.next"
caddy_config_next="${caddy_config}.next"

hash_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

if [[ "${test_mode}" != "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || { echo "Atlas deployment requires root." >&2; exit 1; }
fi
install -d -m 0755 -- "$(dirname -- "${install_lock}")"
exec 6>"${install_lock}"
flock -x 6

while IFS='|' read -r staged expected_hash; do
  [[ -f "${staged}" && ! -L "${staged}" ]] || exit 1
  [[ "$(hash_file "${staged}")" == "${expected_hash}" ]] \
    || { echo "Staged Atlas bundle hash mismatch." >&2; exit 1; }
done <<EOF
${staged_coordinator}|${expected_coordinator_hash}
${staged_unit}|${expected_unit_hash}
${staged_backup}|${expected_backup_hash}
${staged_restore}|${expected_restore_hash}
${staged_role_initializer}|${expected_role_initializer_hash}
${staged_caddy_config}|${expected_caddy_config_hash}
${staged_archive}|${expected_archive_hash}
${staged_environment}|${expected_environment_hash}
EOF

if [[ -e "${state_file}" ]]; then
  [[ -f "${state_file}" && ! -L "${state_file}" ]] \
    || { echo "Refusing recovered-state retirement from an unsafe state path." >&2; exit 1; }
  recorded_coordinator_hash="$(sed -n 's/^coordinator_hash=//p' "${state_file}")"
  [[ "$(grep -c '^coordinator_hash=' "${state_file}")" == "1" \
    && "${recorded_coordinator_hash}" =~ ^[0-9a-f]{64}$ ]] \
    || { echo "Refusing active.state retirement without one recorded coordinator hash." >&2; exit 1; }
  [[ -x "${coordinator}" && ! -L "${coordinator}" ]] \
    || { echo "Refusing recovered-state retirement without the installed coordinator." >&2; exit 1; }
  [[ "$(hash_file "${coordinator}")" == "${recorded_coordinator_hash}" ]] \
    || { echo "Refusing recovered-state retirement through unauthenticated coordinator bytes." >&2; exit 1; }
  if [[ "${test_mode}" != "1" ]]; then
    [[ "$(stat -c '%U:%G:%a' "${coordinator}")" == "root:root:755" ]] \
      || { echo "Refusing recovered-state retirement through unsafe coordinator ownership." >&2; exit 1; }
  fi
  ATLAS_COORDINATOR_INSTALL_LOCK_HELD=1 "${coordinator}" retire-recovered \
    || { echo "Refusing to replace Atlas operations bytes while active.state requires resolution." >&2; exit 1; }
fi

installed_matches=0
if [[ -f "${coordinator}" && ! -L "${coordinator}" && -f "${unit}" && ! -L "${unit}" \
  && -f "${backup_tool}" && ! -L "${backup_tool}" && -f "${restore_tool}" && ! -L "${restore_tool}" \
  && -f "${role_initializer}" && ! -L "${role_initializer}" \
  && -f "${caddy_config}" && ! -L "${caddy_config}" ]] \
  && [[ "$(hash_file "${coordinator}")" == "${expected_coordinator_hash}" ]] \
  && [[ "$(hash_file "${unit}")" == "${expected_unit_hash}" ]] \
  && [[ "$(hash_file "${backup_tool}")" == "${expected_backup_hash}" ]] \
  && [[ "$(hash_file "${restore_tool}")" == "${expected_restore_hash}" ]] \
  && [[ "$(hash_file "${role_initializer}")" == "${expected_role_initializer_hash}" ]] \
  && [[ "$(hash_file "${caddy_config}")" == "${expected_caddy_config_hash}" ]]; then
  if [[ "${test_mode}" == "1" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${coordinator}")" == "root:root:755" \
      && "$(stat -c '%U:%G:%a' "${unit}")" == "root:root:644" \
      && "$(stat -c '%U:%G:%a' "${backup_tool}")" == "root:root:755" \
      && "$(stat -c '%U:%G:%a' "${restore_tool}")" == "root:root:755" \
      && "$(stat -c '%U:%G:%a' "${role_initializer}")" == "root:root:755" \
      && "$(stat -c '%U:%G:%a' "${caddy_config}")" == "root:root:644" ]]; then
    installed_matches=1
  fi
fi

if [[ "${installed_matches}" -ne 1 ]]; then
  if systemctl is-active --quiet atlas-v2-deployment-guardian.service; then
    echo "Refusing to replace Atlas coordinator bytes while its guardian is active." >&2
    exit 1
  fi
  if [[ -e "${state_file}" ]]; then
    echo "Refusing to replace Atlas coordinator bytes while active.state requires resolution." >&2
    exit 1
  fi
  if [[ "${test_mode}" == "1" ]]; then
    install -m 0755 "${staged_coordinator}" "${coordinator_next}"
    install -m 0644 "${staged_unit}" "${unit_next}"
    install -m 0755 "${staged_backup}" "${backup_next}"
    install -m 0755 "${staged_restore}" "${restore_next}"
    install -m 0755 "${staged_role_initializer}" "${role_initializer_next}"
    install -m 0644 "${staged_caddy_config}" "${caddy_config_next}"
  else
    install -o root -g root -m 0755 -d "$(dirname -- "${backup_tool}")"
    install -o root -g root -m 0755 "${staged_coordinator}" "${coordinator_next}"
    install -o root -g root -m 0644 "${staged_unit}" "${unit_next}"
    install -o root -g root -m 0755 "${staged_backup}" "${backup_next}"
    install -o root -g root -m 0755 "${staged_restore}" "${restore_next}"
    install -o root -g root -m 0755 "${staged_role_initializer}" "${role_initializer_next}"
    install -o root -g root -m 0644 "${staged_caddy_config}" "${caddy_config_next}"
  fi
  [[ "$(hash_file "${coordinator_next}")" == "${expected_coordinator_hash}" ]]
  [[ "$(hash_file "${unit_next}")" == "${expected_unit_hash}" ]]
  [[ "$(hash_file "${backup_next}")" == "${expected_backup_hash}" ]]
  [[ "$(hash_file "${restore_next}")" == "${expected_restore_hash}" ]]
  [[ "$(hash_file "${role_initializer_next}")" == "${expected_role_initializer_hash}" ]]
  [[ "$(hash_file "${caddy_config_next}")" == "${expected_caddy_config_hash}" ]]
  mv -f -- "${coordinator_next}" "${coordinator}"
  mv -f -- "${unit_next}" "${unit}"
  mv -f -- "${backup_next}" "${backup_tool}"
  mv -f -- "${restore_next}" "${restore_tool}"
  mv -f -- "${role_initializer_next}" "${role_initializer}"
  mv -f -- "${caddy_config_next}" "${caddy_config}"
fi

[[ "$(hash_file "${coordinator}")" == "${expected_coordinator_hash}" ]]
[[ "$(hash_file "${unit}")" == "${expected_unit_hash}" ]]
[[ "$(hash_file "${backup_tool}")" == "${expected_backup_hash}" ]]
[[ "$(hash_file "${restore_tool}")" == "${expected_restore_hash}" ]]
[[ "$(hash_file "${role_initializer}")" == "${expected_role_initializer_hash}" ]]
[[ "$(hash_file "${caddy_config}")" == "${expected_caddy_config_hash}" ]]
if [[ "${test_mode}" != "1" ]]; then
  [[ "$(stat -c '%U:%G:%a' "${coordinator}")" == "root:root:755" ]]
  [[ "$(stat -c '%U:%G:%a' "${unit}")" == "root:root:644" ]]
  [[ "$(stat -c '%U:%G:%a' "${backup_tool}")" == "root:root:755" ]]
  [[ "$(stat -c '%U:%G:%a' "${restore_tool}")" == "root:root:755" ]]
  [[ "$(stat -c '%U:%G:%a' "${role_initializer}")" == "root:root:755" ]]
  [[ "$(stat -c '%U:%G:%a' "${caddy_config}")" == "root:root:644" ]]
fi
systemctl daemon-reload
loaded_unit="$(systemctl cat --no-pager --full atlas-v2-deployment-guardian.service)"
loaded_hash="$(printf '%s\n' "${loaded_unit}" | sed '1{/^# \/etc\/systemd\/system\/atlas-v2-deployment-guardian\.service$/d;}' | sha256sum | awk '{print $1}')"
[[ "${loaded_hash}" == "${expected_unit_hash}" ]] \
  || { echo "Loaded Atlas guardian unit differs from reviewed bytes." >&2; exit 1; }
if systemctl is-active --quiet atlas-v2-deployment-guardian.service; then
  echo "Refusing Atlas begin while the deployment guardian is already active." >&2
  exit 1
fi
[[ ! -e "${state_file}" ]] || { echo "Refusing Atlas begin while active.state exists." >&2; exit 1; }
ATLAS_COORDINATOR_INSTALL_LOCK_HELD=1 exec "${coordinator}" begin \
  "${deployment_token}" "${remote_dir}" "${backup_root}" "${lease_seconds}" \
  "${bundle_version}" "${expected_coordinator_hash}" "${expected_unit_hash}" \
  "${expected_backup_hash}" "${expected_restore_hash}" \
  "${expected_role_initializer_hash}" "${expected_caddy_config_hash}" "${stage}" \
  "${expected_archive_hash}" "${expected_environment_hash}"
REMOTE_INSTALL
}

run_coordinator() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${COORDINATOR_PATH}" "$@" <<'REMOTE_COORDINATOR'
set -euo pipefail
coordinator="$1"
shift
[[ -x "${coordinator}" ]] || { echo "Atlas V2 deployment coordinator is not installed." >&2; exit 1; }
if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
  exec "${coordinator}" "$@"
fi
if [[ "${EUID}" -eq 0 ]]; then
  [[ "$(id -u)" -eq 0 ]] || { echo "Atlas coordinator commands require root." >&2; exit 1; }
  exec "${coordinator}" "$@"
fi
echo "Atlas coordinator commands require root." >&2
exit 1
REMOTE_COORDINATOR
}

# The coordinator takes the host-wide durable claim before backup, quiescence,
# source synchronization, role rotation, or migration can mutate the release.
BEGIN_OUTPUT="$(install_verified_coordinator_and_begin)"

PREVIOUS_COMMIT="none"
EXACT_BACKUP="none"
BEGIN_TOKEN=""
BEGIN_REMOTE_DIR=""
BEGIN_BACKUP_ROOT=""
BEGIN_WEB_CONTAINER=""
BEGIN_WORKER_CONTAINER=""
seen_keys="|"
while IFS='=' read -r state_key state_value; do
  [[ -n "${state_key}" && "${seen_keys}" != *"|${state_key}|"* ]] \
    || fail "coordinator begin response contained a duplicate or empty key."
  seen_keys="${seen_keys}${state_key}|"
  case "${state_key}" in
    TOKEN) BEGIN_TOKEN="${state_value}" ;;
    REMOTE_DIR) BEGIN_REMOTE_DIR="${state_value}" ;;
    REMOTE_BACKUP_ROOT) BEGIN_BACKUP_ROOT="${state_value}" ;;
    PREVIOUS_COMMIT) PREVIOUS_COMMIT="${state_value}" ;;
    WEB_CONTAINER) BEGIN_WEB_CONTAINER="${state_value}" ;;
    WORKER_CONTAINER) BEGIN_WORKER_CONTAINER="${state_value}" ;;
    *) fail "coordinator begin response contained an unexpected key." ;;
  esac
done <<< "${BEGIN_OUTPUT}"
[[ "${BEGIN_TOKEN}" == "${DEPLOYMENT_TOKEN}" ]] || fail "coordinator returned a mismatched deployment token."
[[ "${BEGIN_REMOTE_DIR}" == "${REMOTE_DIR}" && "${BEGIN_BACKUP_ROOT}" == "${REMOTE_BACKUP_ROOT}" ]] \
  || fail "coordinator returned mismatched deployment paths."
[[ "${PREVIOUS_COMMIT}" == "none" || "${PREVIOUS_COMMIT}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "coordinator returned an invalid previous commit."
[[ "${BEGIN_WEB_CONTAINER}" == "none" || "${BEGIN_WEB_CONTAINER}" =~ ^[A-Za-z0-9_.-]+$ ]] \
  || fail "coordinator returned an invalid web writer snapshot."
[[ "${BEGIN_WORKER_CONTAINER}" == "none" || "${BEGIN_WORKER_CONTAINER}" =~ ^[A-Za-z0-9_.-]+$ ]] \
  || fail "coordinator returned an invalid worker writer snapshot."

DEPLOYMENT_COMPLETE=0
BOUNDARY_CROSSED=0
on_deploy_exit() {
  local failure_status="$?"
  trap - EXIT INT TERM
  if [[ "${failure_status}" -ne 0 && "${DEPLOYMENT_COMPLETE}" -eq 0 ]]; then
    set +e
    run_coordinator fail "${DEPLOYMENT_TOKEN}" >/dev/null
    {
      echo "Atlas V2 deployment failed with status ${failure_status}."
      echo "Previous Git commit: ${PREVIOUS_COMMIT}"
      echo "Exact pre-deploy backup: ${EXACT_BACKUP}"
      if [[ "${BOUNDARY_CROSSED}" -eq 1 ]]; then
        echo "Migration compatibility boundary crossed; the durable guardian keeps all Atlas writers stopped (fail closed)."
        echo "Operator recovery requires a reviewed restore or forward fix."
      else
        echo "Failure occurred before migration; the durable guardian restores only the exact prior-active writers."
      fi
    } >&2
  fi
  case "${LOCAL_CANDIDATE_STAGE:-}" in
    "${TMPDIR:-/tmp}"/atlas-v2-candidate.*) /bin/rm -rf -- "${LOCAL_CANDIDATE_STAGE}" ;;
  esac
  exit "${failure_status}"
}
trap on_deploy_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_coordinator assert "${DEPLOYMENT_TOKEN}" prepared
BACKUP_OUTPUT="$(run_coordinator guard "${DEPLOYMENT_TOKEN}" prepared backup)"
[[ "$(printf '%s\n' "${BACKUP_OUTPUT}" | wc -l | tr -d '[:space:]')" == "1" ]] \
  || fail "remote backup returned an invalid response."
case "${BACKUP_OUTPUT}" in
  EXACT_BACKUP=*) EXACT_BACKUP="${BACKUP_OUTPUT#EXACT_BACKUP=}" ;;
  *) fail "remote backup did not return an exact backup path." ;;
esac
if [[ "${EXACT_BACKUP}" != "none" ]]; then
  valid_path "${EXACT_BACKUP}" || fail "remote backup returned an invalid exact path."
  path_is_equal_or_descendant "${EXACT_BACKUP}" "${REMOTE_BACKUP_ROOT}" \
    || fail "remote backup path escaped the configured backup root."
  run_coordinator annotate "${DEPLOYMENT_TOKEN}" "${PREVIOUS_COMMIT}" "${EXACT_BACKUP}"
  if ! run_coordinator guard "${DEPLOYMENT_TOKEN}" prepared restore-backup; then
    fail "fresh pre-deploy backup failed its non-destructive restore test."
  fi
  echo "Fresh pre-deploy backup passed its non-destructive restore test: ${EXACT_BACKUP}" >&2
fi
run_coordinator transition "${DEPLOYMENT_TOKEN}" prepared quiesced
run_coordinator transition "${DEPLOYMENT_TOKEN}" quiesced syncing
run_coordinator guard "${DEPLOYMENT_TOKEN}" syncing sync-release
run_coordinator transition "${DEPLOYMENT_TOKEN}" syncing synced
run_coordinator candidate "${DEPLOYMENT_TOKEN}" "${LOCAL_COMMIT}"
run_coordinator guard "${DEPLOYMENT_TOKEN}" synced build-db

# Credentials and schema can become incompatible with the prior release after
# this exact durable transition. Every later failure remains fail closed.
run_coordinator transition "${DEPLOYMENT_TOKEN}" synced boundary
BOUNDARY_CROSSED=1

run_coordinator guard "${DEPLOYMENT_TOKEN}" boundary rotate-roles
run_coordinator guard "${DEPLOYMENT_TOKEN}" boundary migrate
run_coordinator guard "${DEPLOYMENT_TOKEN}" boundary verify-contract
run_coordinator guard "${DEPLOYMENT_TOKEN}" boundary start-writers
run_coordinator renew "${DEPLOYMENT_TOKEN}" boundary

TARGET_HEALTH_RESPONSE="$(ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- <<'REMOTE_HEALTH'
set -euo pipefail
curl --fail --silent --show-error \
  --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  --noproxy '*' \
  --resolve atlas.rangeway.app:443:127.0.0.1 \
  https://atlas.rangeway.app/api/v2/ready
REMOTE_HEALTH
)"
HEALTH_JSON="${TARGET_HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2" || health?.contractVersion !== "atlas-v2-foundation-v1" || health?.release !== process.argv[1]) {
    throw new Error("Target readiness did not match the exact Atlas V2 release contract.");
  }
' "${LOCAL_COMMIT}"
run_coordinator renew "${DEPLOYMENT_TOKEN}" boundary

run_coordinator assert "${DEPLOYMENT_TOKEN}" boundary
ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- "${REMOTE_DIR}" <<'REMOTE_WORKER_HEALTH'
set -euo pipefail
cd -- "$1"
worker_container="$(docker compose ps -q worker)"
[[ -n "${worker_container}" ]]
[[ "$(docker inspect --format '{{.State.Health.Status}}' "${worker_container}")" == "healthy" ]]
REMOTE_WORKER_HEALTH
run_coordinator renew "${DEPLOYMENT_TOKEN}" boundary

PUBLIC_HEALTH_RESPONSE="$(curl --fail --silent --show-error \
  --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  https://atlas.rangeway.app/api/v2/ready)"
HEALTH_JSON="${PUBLIC_HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2" || health?.contractVersion !== "atlas-v2-foundation-v1" || health?.release !== process.argv[1]) {
    throw new Error("Public readiness did not match the exact Atlas V2 release contract.");
  }
' "${LOCAL_COMMIT}"

run_coordinator assert "${DEPLOYMENT_TOKEN}" boundary
run_coordinator complete "${DEPLOYMENT_TOKEN}" "${LOCAL_COMMIT}"
DEPLOYMENT_COMPLETE=1
/bin/rm -rf -- "${LOCAL_CANDIDATE_STAGE}"
trap - EXIT INT TERM

echo "Atlas V2 release ${LOCAL_COMMIT} passed target-bound and public HTTPS health verification."
echo "No rollback was run automatically."
echo "Previous Git commit: ${PREVIOUS_COMMIT}"
echo "Exact pre-deploy backup: ${EXACT_BACKUP}"
if [[ "${PREVIOUS_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Rollback guidance: create a clean worktree at ${PREVIOUS_COMMIT}, review it, and deploy that release through this coordinator."
else
  echo "Rollback guidance: no previous Atlas V2 Git commit was recorded; do not attempt an automated code rollback."
fi
if [[ "${EXACT_BACKUP}" != "none" ]]; then
  echo "Data rollback guidance: verify ${EXACT_BACKUP} with deploy/restore-test.sh, then use an operator-reviewed restore procedure."
else
  echo "Data rollback guidance: no pre-deploy Atlas V2 backup exists because this was the first V2 database release."
fi
