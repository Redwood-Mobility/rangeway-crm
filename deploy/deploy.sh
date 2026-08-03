#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${REPOSITORY_ROOT}"

REMOTE_HOST="${ATLAS_HOST:-}"
REMOTE_USER="${ATLAS_USER:-atlas}"
REMOTE_DIR="${ATLAS_DIR:-/opt/atlas-v2}"
REMOTE_BACKUP_ROOT="${ATLAS_BACKUP_ROOT:-/var/backups/atlas-v2}"
ENV_FILE_INPUT="${ATLAS_ENV_FILE:-}"
SSH_KEY="${ATLAS_SSH_KEY:-}"
COORDINATOR_PATH="${ATLAS_COORDINATOR_PATH:-/usr/local/sbin/atlas-v2-deployment-coordinator}"
GUARDIAN_UNIT_PATH="${ATLAS_GUARDIAN_UNIT_PATH:-/etc/systemd/system/atlas-v2-deployment-guardian.service}"
COORDINATOR_STATE_FILE="${ATLAS_COORDINATOR_STATE_FILE:-/var/lib/atlas-v2-deployment/active.state}"
COORDINATOR_STAGE="${ATLAS_COORDINATOR_STAGE:-/opt/atlas-v2/.atlas-coordinator-staging}"
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
path_is_equal_or_descendant "${REMOTE_BACKUP_ROOT}" "${REMOTE_DIR}" \
  && fail "ATLAS_BACKUP_ROOT must be outside the synchronized ATLAS_DIR tree."
[[ "${LEASE_SECONDS}" =~ ^[0-9]+$ && "${LEASE_SECONDS}" -ge 2 && "${LEASE_SECONDS}" -le 900 ]] \
  || fail "ATLAS_DEPLOYMENT_LEASE_SECONDS must be between 2 and 900 seconds."
if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" != "1" ]]; then
  [[ "${REMOTE_USER}" == "atlas" ]] || fail "ATLAS_USER must be the dedicated atlas deploy operator."
  [[ "${REMOTE_DIR}" == "/opt/atlas-v2" ]] || fail "ATLAS_DIR must be /opt/atlas-v2 for the supported operator model."
  [[ "${REMOTE_BACKUP_ROOT}" == "/var/backups/atlas-v2" ]] || fail "ATLAS_BACKUP_ROOT must be /var/backups/atlas-v2 for the supported operator model."
  [[ "${COORDINATOR_PATH}" == "/usr/local/sbin/atlas-v2-deployment-coordinator" ]] \
    || fail "ATLAS_COORDINATOR_PATH must use the bootstrap-installed coordinator."
  [[ "${GUARDIAN_UNIT_PATH}" == "/etc/systemd/system/atlas-v2-deployment-guardian.service" ]] \
    || fail "ATLAS_GUARDIAN_UNIT_PATH must use the bootstrap-installed unit."
  [[ "${COORDINATOR_STAGE}" == "/opt/atlas-v2/.atlas-coordinator-staging" ]] \
    || fail "ATLAS_COORDINATOR_STAGE must use the bootstrap-owned staging directory."
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

for command_name in git npm npx rsync ssh curl node; do
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

COORDINATOR_SOURCE="${REPOSITORY_ROOT}/deploy/deployment-coordinator.sh"
GUARDIAN_UNIT_SOURCE="${REPOSITORY_ROOT}/deploy/systemd/atlas-v2-deployment-guardian.service"
[[ -f "${COORDINATOR_SOURCE}" && ! -L "${COORDINATOR_SOURCE}" ]] \
  || fail "reviewed deployment coordinator source is unavailable."
[[ -f "${GUARDIAN_UNIT_SOURCE}" && ! -L "${GUARDIAN_UNIT_SOURCE}" ]] \
  || fail "reviewed deployment guardian unit source is unavailable."
COORDINATOR_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${COORDINATOR_SOURCE}")"
GUARDIAN_UNIT_SHA256="$(node --input-type=module -e \
  'import fs from "node:fs"; import crypto from "node:crypto"; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
  "${GUARDIAN_UNIT_SOURCE}")"
[[ "${COORDINATOR_SHA256}" =~ ^[0-9a-f]{64}$ && "${GUARDIAN_UNIT_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "could not hash reviewed coordinator assets."

install_verified_coordinator() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${COORDINATOR_STAGE}" "${ATLAS_COORDINATOR_TEST_MODE:-0}" <<'REMOTE_STAGE'
set -euo pipefail
stage="$1"
test_mode="$2"
if [[ "${test_mode}" == "1" ]]; then
  install -d -m 0700 -- "${stage}"
else
  [[ "${stage}" == "/opt/atlas-v2/.atlas-coordinator-staging" ]] || exit 1
  [[ -d "${stage}" && ! -L "${stage}" ]] || exit 1
  [[ "$(stat -c '%U:%G:%a' "${stage}")" == "atlas:atlas:700" ]] || exit 1
fi
REMOTE_STAGE

  rsync -az --chmod=F600 -e "${RSYNC_RSH}" \
    "${COORDINATOR_SOURCE}" "${GUARDIAN_UNIT_SOURCE}" \
    "${REMOTE_TARGET}:${COORDINATOR_STAGE}/"

  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${COORDINATOR_STAGE}" "${COORDINATOR_PATH}" "${GUARDIAN_UNIT_PATH}" \
    "${COORDINATOR_STATE_FILE}" "${COORDINATOR_SHA256}" "${GUARDIAN_UNIT_SHA256}" \
    "${ATLAS_COORDINATOR_TEST_MODE:-0}" <<'REMOTE_INSTALL'
set -euo pipefail
stage="$1"
coordinator="$2"
unit="$3"
state_file="$4"
expected_coordinator_hash="$5"
expected_unit_hash="$6"
test_mode="$7"
staged_coordinator="${stage}/deployment-coordinator.sh"
staged_unit="${stage}/atlas-v2-deployment-guardian.service"
coordinator_next="${coordinator}.next"
unit_next="${unit}.next"

privileged() {
  if [[ "${test_mode}" == "1" || "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

hash_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

[[ -f "${staged_coordinator}" && ! -L "${staged_coordinator}" ]] || exit 1
[[ -f "${staged_unit}" && ! -L "${staged_unit}" ]] || exit 1
[[ "$(hash_file "${staged_coordinator}")" == "${expected_coordinator_hash}" ]] \
  || { echo "Staged Atlas coordinator hash mismatch." >&2; exit 1; }
[[ "$(hash_file "${staged_unit}")" == "${expected_unit_hash}" ]] \
  || { echo "Staged Atlas guardian unit hash mismatch." >&2; exit 1; }

installed_matches=0
if [[ -f "${coordinator}" && ! -L "${coordinator}" && -f "${unit}" && ! -L "${unit}" ]] \
  && [[ "$(hash_file "${coordinator}")" == "${expected_coordinator_hash}" ]] \
  && [[ "$(hash_file "${unit}")" == "${expected_unit_hash}" ]]; then
  if [[ "${test_mode}" == "1" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${coordinator}")" == "root:root:755" \
      && "$(stat -c '%U:%G:%a' "${unit}")" == "root:root:644" ]]; then
    installed_matches=1
  fi
fi

if [[ "${installed_matches}" -ne 1 ]]; then
  if privileged systemctl is-active --quiet atlas-v2-deployment-guardian.service; then
    echo "Refusing to replace Atlas coordinator bytes while its guardian is active." >&2
    exit 1
  fi
  if [[ "${test_mode}" == "1" && -e "${state_file}" ]]; then
    echo "Refusing to replace Atlas coordinator bytes while active.state requires resolution." >&2
    exit 1
  fi
  if [[ "${test_mode}" != "1" ]] \
    && privileged stat -c %F "${state_file}" >/dev/null 2>&1; then
    echo "Refusing to replace Atlas coordinator bytes while active.state requires resolution." >&2
    exit 1
  fi
  if [[ "${test_mode}" == "1" ]]; then
    install -m 0755 "${staged_coordinator}" "${coordinator_next}"
    install -m 0644 "${staged_unit}" "${unit_next}"
  else
    privileged install -o root -g root -m 0755 "${staged_coordinator}" "${coordinator_next}"
    privileged install -o root -g root -m 0644 "${staged_unit}" "${unit_next}"
  fi
  [[ "$(hash_file "${coordinator_next}")" == "${expected_coordinator_hash}" ]]
  [[ "$(hash_file "${unit_next}")" == "${expected_unit_hash}" ]]
  privileged mv -f -- "${coordinator_next}" "${coordinator}"
  privileged mv -f -- "${unit_next}" "${unit}"
fi

[[ "$(hash_file "${coordinator}")" == "${expected_coordinator_hash}" ]]
[[ "$(hash_file "${unit}")" == "${expected_unit_hash}" ]]
if [[ "${test_mode}" != "1" ]]; then
  [[ "$(stat -c '%U:%G:%a' "${coordinator}")" == "root:root:755" ]]
  [[ "$(stat -c '%U:%G:%a' "${unit}")" == "root:root:644" ]]
fi
privileged systemctl daemon-reload
loaded_unit="$(privileged systemctl cat --no-pager --full atlas-v2-deployment-guardian.service)"
loaded_hash="$(printf '%s\n' "${loaded_unit}" | sed '1{/^# \/etc\/systemd\/system\/atlas-v2-deployment-guardian\.service$/d;}' | sha256sum | awk '{print $1}')"
[[ "${loaded_hash}" == "${expected_unit_hash}" ]] \
  || { echo "Loaded Atlas guardian unit differs from reviewed bytes." >&2; exit 1; }
REMOTE_INSTALL
}

install_verified_coordinator

run_coordinator() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${COORDINATOR_PATH}" "$@" <<'REMOTE_COORDINATOR'
set -euo pipefail
coordinator="$1"
shift
[[ -x "${coordinator}" ]] || { echo "Atlas V2 deployment coordinator is not installed." >&2; exit 1; }
if [[ "${EUID}" -eq 0 || "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
  exec "${coordinator}" "$@"
fi
exec sudo -n "${coordinator}" "$@"
REMOTE_COORDINATOR
}

# The coordinator takes the host-wide durable claim before backup, quiescence,
# source synchronization, role rotation, or migration can mutate the release.
BEGIN_OUTPUT="$(run_coordinator begin "${DEPLOYMENT_TOKEN}" "${REMOTE_DIR}" \
  "${REMOTE_BACKUP_ROOT}" "${LEASE_SECONDS}")"

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

RSYNC_TREE_ARGS=(
  -az --delete-delay
  -e "${RSYNC_RSH}"
  --exclude ".git/"
  --exclude ".env"
  --exclude ".env.*"
  --exclude ".atlas-release"
  --exclude ".atlas-coordinator-staging/"
  --exclude "node_modules/"
  --exclude "dist/"
  --exclude "backups/"
  --exclude "artifacts/"
  --exclude "atlas-db/"
  --exclude "atlas-artifacts/"
  --exclude "data/"
  --exclude "uploads/"
)
if [[ -n "${ENV_SOURCE_EXCLUDE}" ]]; then
  RSYNC_TREE_ARGS+=(--exclude "${ENV_SOURCE_EXCLUDE}")
fi
run_coordinator assert "${DEPLOYMENT_TOKEN}" quiesced
rsync "${RSYNC_TREE_ARGS[@]}" ./ "${REMOTE_TARGET}:${REMOTE_DIR}/"
run_coordinator renew "${DEPLOYMENT_TOKEN}" quiesced

run_coordinator assert "${DEPLOYMENT_TOKEN}" quiesced
rsync -az --chmod=F600 -e "${RSYNC_RSH}" \
  "${ENV_FILE}" "${REMOTE_TARGET}:${REMOTE_DIR}/.env"
run_coordinator renew "${DEPLOYMENT_TOKEN}" quiesced
run_coordinator candidate "${DEPLOYMENT_TOKEN}" "${LOCAL_COMMIT}"
run_coordinator guard "${DEPLOYMENT_TOKEN}" quiesced build-db

# Credentials and schema can become incompatible with the prior release after
# this exact durable transition. Every later failure remains fail closed.
run_coordinator transition "${DEPLOYMENT_TOKEN}" quiesced boundary
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
