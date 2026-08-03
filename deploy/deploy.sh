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
path_is_equal_or_descendant "${REMOTE_BACKUP_ROOT}" "${REMOTE_DIR}" \
  && fail "ATLAS_BACKUP_ROOT must be outside the synchronized ATLAS_DIR tree."
[[ "${LEASE_SECONDS}" =~ ^[0-9]+$ && "${LEASE_SECONDS}" -ge 2 && "${LEASE_SECONDS}" -le 900 ]] \
  || fail "ATLAS_DEPLOYMENT_LEASE_SECONDS must be between 2 and 900 seconds."

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

run_remote_backup() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${REMOTE_DIR}" "${REMOTE_BACKUP_ROOT}" "${PREVIOUS_COMMIT}" <<'REMOTE_BACKUP'
set -euo pipefail
remote_dir="$1"
backup_root="$2"
previous_commit="$3"
exact_backup="none"
cd -- "${remote_dir}"

if docker volume inspect atlas-db >/dev/null 2>&1; then
  [[ -x deploy/backup.sh ]] || { echo "Existing Atlas V2 database found, but backup.sh is unavailable." >&2; exit 1; }
  grep -Fxq 'ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"' deploy/backup.sh \
    || { echo "Existing database backup tool has an unsupported format." >&2; exit 1; }
  backup_output="$(BACKUP_ROOT="${backup_root}" COMPOSE_PROJECT_NAME=atlas-v2 \
    ATLAS_GIT_COMMIT="${previous_commit}" ATLAS_KEEP_QUIESCED=1 ./deploy/backup.sh)"
  [[ "$(printf '%s\n' "${backup_output}" | wc -l | tr -d '[:space:]')" == "1" ]] \
    || { echo "Backup script did not emit exactly one machine-readable path." >&2; exit 1; }
  case "${backup_output}" in
    ATLAS_BACKUP_PATH=*) exact_backup="${backup_output#ATLAS_BACKUP_PATH=}" ;;
    *) echo "Backup script did not emit ATLAS_BACKUP_PATH." >&2; exit 1 ;;
  esac
  exact_backup="$(realpath -m -- "${exact_backup}")"
  backup_root="$(realpath -m -- "${backup_root}")"
  case "${exact_backup}" in "${backup_root}"/*) ;; *) echo "Backup escaped its configured root." >&2; exit 1 ;; esac
  for backup_file in atlas-postgres.dump atlas-artifacts.tgz metadata.txt manifest.sha256; do
    [[ -s "${exact_backup}/${backup_file}" ]] || { echo "Exact backup is incomplete: ${backup_file}." >&2; exit 1; }
  done
  (cd -- "${exact_backup}" && sha256sum --check manifest.sha256) >&2
else
  docker compose stop web worker
fi
printf 'EXACT_BACKUP=%s\n' "${exact_backup}"
REMOTE_BACKUP
}
BACKUP_OUTPUT="$(run_remote_backup)"
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
  if ! ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${REMOTE_DIR}" "${EXACT_BACKUP}" <<'REMOTE_RESTORE_TEST'
set -euo pipefail
cd -- "$1"
[[ -x deploy/restore-test.sh ]] || { echo "Non-destructive restore test is unavailable." >&2; exit 1; }
./deploy/restore-test.sh "$2"
REMOTE_RESTORE_TEST
  then
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
rsync "${RSYNC_TREE_ARGS[@]}" ./ "${REMOTE_TARGET}:${REMOTE_DIR}/"
run_coordinator renew "${DEPLOYMENT_TOKEN}"

rsync -az --chmod=F600 -e "${RSYNC_RSH}" \
  "${ENV_FILE}" "${REMOTE_TARGET}:${REMOTE_DIR}/.env"
run_coordinator renew "${DEPLOYMENT_TOKEN}"

ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- "${REMOTE_DIR}" <<'REMOTE_BUILD'
set -euo pipefail
cd -- "$1"
docker compose config >/dev/null
docker compose build web worker
docker compose up -d db
db_container="$(docker compose ps -q db)"
[[ -n "${db_container}" ]] || { echo "Atlas V2 database container did not start." >&2; exit 1; }
for _attempt in $(seq 1 60); do
  db_health="$(docker inspect --format '{{.State.Health.Status}}' "${db_container}")"
  [[ "${db_health}" == "healthy" ]] && break
  [[ "${db_health}" != "unhealthy" ]] || { docker compose logs db >&2; exit 1; }
  sleep 2
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "${db_container}")" == "healthy" ]] \
  || { echo "Atlas V2 database did not become healthy." >&2; docker compose logs db >&2; exit 1; }
REMOTE_BUILD
run_coordinator renew "${DEPLOYMENT_TOKEN}"

# Credentials and schema can become incompatible with the prior release after
# this exact durable transition. Every later failure remains fail closed.
run_coordinator transition "${DEPLOYMENT_TOKEN}" quiesced boundary
BOUNDARY_CROSSED=1

ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- "${REMOTE_DIR}" <<'REMOTE_MIGRATE_AND_START'
set -euo pipefail
cd -- "$1"
docker compose exec -T db /docker-entrypoint-initdb.d/001-atlas-roles.sh
docker compose --profile operations run --rm migrator
docker compose up -d web worker caddy
docker compose up -d --wait --wait-timeout 180
docker compose ps
REMOTE_MIGRATE_AND_START
run_coordinator renew "${DEPLOYMENT_TOKEN}"

TARGET_HEALTH_RESPONSE="$(ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- <<'REMOTE_HEALTH'
set -euo pipefail
curl --fail --silent --show-error \
  --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  --noproxy '*' \
  --resolve atlas.rangeway.app:443:127.0.0.1 \
  https://atlas.rangeway.app/api/v2/health
REMOTE_HEALTH
)"
HEALTH_JSON="${TARGET_HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2") throw new Error("Target health was not Atlas V2.");
'
run_coordinator renew "${DEPLOYMENT_TOKEN}"

PUBLIC_HEALTH_RESPONSE="$(curl --fail --silent --show-error \
  --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  https://atlas.rangeway.app/api/v2/health)"
HEALTH_JSON="${PUBLIC_HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2") throw new Error("Public health was not Atlas V2.");
'

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
