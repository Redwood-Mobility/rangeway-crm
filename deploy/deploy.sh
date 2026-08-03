#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${REPOSITORY_ROOT}"

REMOTE_HOST="${ATLAS_HOST:-}"
REMOTE_USER="${ATLAS_USER:-root}"
REMOTE_DIR_INPUT="${ATLAS_DIR:-/opt/atlas-v2}"
REMOTE_BACKUP_ROOT_INPUT="${ATLAS_BACKUP_ROOT:-/var/backups/atlas-v2}"
ENV_FILE_INPUT="${ATLAS_ENV_FILE:-}"
SSH_KEY="${ATLAS_SSH_KEY:-}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSYNC_RSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

fail() {
  echo "Atlas V2 deployment refused: $*" >&2
  exit 1
}

canonicalize_absolute_path() {
  local candidate="$1"
  local component
  local -a components=()
  local -a canonical=()

  [[ "${candidate}" == /* ]] || return 1
  IFS='/' read -r -a components <<< "${candidate}"
  for component in "${components[@]}"; do
    case "${component}" in
      ""|.) ;;
      ..)
        if [[ "${#canonical[@]}" -gt 0 ]]; then
          unset 'canonical[${#canonical[@]}-1]'
        fi
        ;;
      *) canonical+=("${component}") ;;
    esac
  done

  if [[ "${#canonical[@]}" -eq 0 ]]; then
    printf '/\n'
  else
    local joined
    joined="$(IFS=/; printf '%s' "${canonical[*]}")"
    printf '/%s\n' "${joined}"
  fi
}

validate_remote_path_input() {
  local candidate="$1"
  local label="$2"
  [[ "${candidate}" != *'*'* && "${candidate}" != *'?'* && "${candidate}" != *'['* ]] \
    || fail "${label} cannot contain a glob."
  [[ "${candidate}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "${label} contains unsupported characters."
}

path_is_equal_or_descendant() {
  local candidate="$1"
  local ancestor="$2"
  [[ "${candidate}" == "${ancestor}" || "${candidate}" == "${ancestor}/"* ]]
}

validate_canonical_remote_path() {
  local candidate="$1"
  local label="$2"
  local lexical_path

  validate_remote_path_input "${candidate}" "${label}"
  [[ "${candidate}" != "/" ]] || fail "${label} cannot resolve to the filesystem root."
  lexical_path="$(canonicalize_absolute_path "${candidate}")" \
    || fail "${label} must be an absolute path."
  [[ "${lexical_path}" == "${candidate}" ]] \
    || fail "${label} did not return one canonical path."
}

[[ -n "${REMOTE_HOST}" ]] || fail "set ATLAS_HOST to the target VPS hostname or IP."
[[ "${REMOTE_HOST}" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "ATLAS_HOST contains unsupported characters."
[[ "${REMOTE_USER}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "ATLAS_USER contains unsupported characters."
validate_remote_path_input "${REMOTE_DIR_INPUT}" "ATLAS_DIR"
validate_remote_path_input "${REMOTE_BACKUP_ROOT_INPUT}" "ATLAS_BACKUP_ROOT"
REMOTE_DIR="$(canonicalize_absolute_path "${REMOTE_DIR_INPUT}")" \
  || fail "ATLAS_DIR must be an absolute path."
REMOTE_BACKUP_ROOT="$(canonicalize_absolute_path "${REMOTE_BACKUP_ROOT_INPUT}")" \
  || fail "ATLAS_BACKUP_ROOT must be an absolute path."
[[ "${REMOTE_DIR}" != "/" ]] || fail "ATLAS_DIR cannot resolve to the filesystem root."
[[ "${REMOTE_BACKUP_ROOT}" != "/" ]] || fail "ATLAS_BACKUP_ROOT cannot resolve to the filesystem root."
if path_is_equal_or_descendant "${REMOTE_BACKUP_ROOT}" "${REMOTE_DIR}"; then
  fail "ATLAS_BACKUP_ROOT must be outside the synchronized ATLAS_DIR tree."
fi

[[ -n "${ENV_FILE_INPUT}" ]] || fail "set ATLAS_ENV_FILE to the production environment file."
[[ -f "${ENV_FILE_INPUT}" ]] || fail "production environment file is not a regular file: ${ENV_FILE_INPUT}"
command -v realpath >/dev/null 2>&1 || fail "required local command is unavailable: realpath"
ENV_FILE="$(realpath "${ENV_FILE_INPUT}")"
[[ -f "${ENV_FILE}" ]] || fail "canonical production environment path is not a regular file: ${ENV_FILE}"
if grep -q "REPLACE_WITH" "${ENV_FILE}"; then
  fail "production environment file still contains REPLACE_WITH placeholders."
fi
for required_key in POSTGRES_PASSWORD DATABASE_URL SESSION_SECRET ATLAS_ORIGIN AUTH_MODE; do
  grep -Eq "^${required_key}=.+$" "${ENV_FILE}" \
    || fail "production environment file is missing ${required_key}."
done
grep -Eq '^DATABASE_URL=postgres(ql)?://[^@]+@db:5432/atlas(\?.*)?$' "${ENV_FILE}" \
  || fail "DATABASE_URL must target the Compose service db:5432/atlas."

ENV_SOURCE_EXCLUDE=""
case "${ENV_FILE}" in
  "${REPOSITORY_ROOT}"/*)
    ENV_SOURCE_EXCLUDE="/${ENV_FILE#"${REPOSITORY_ROOT}/"}"
    ;;
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

resolve_remote_paths() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${REMOTE_DIR}" "${REMOTE_BACKUP_ROOT}" <<'REMOTE_PATHS'
set -euo pipefail
remote_dir="$(realpath -m -- "$1")"
backup_root="$(realpath -m -- "$2")"
[[ "${remote_dir}" != "/" && "${backup_root}" != "/" ]] || exit 1
case "${backup_root}" in
  "${remote_dir}"|"${remote_dir}"/*)
    echo "ATLAS_BACKUP_ROOT resolves inside the synchronized ATLAS_DIR tree." >&2
    exit 1
    ;;
esac
printf 'REMOTE_DIR=%s\n' "${remote_dir}"
printf 'REMOTE_BACKUP_ROOT=%s\n' "${backup_root}"
REMOTE_PATHS
}

# Resolve remote symlinks and dot segments before the first remote mutation.
REMOTE_PATH_STATE="$(resolve_remote_paths 2> >(tee /dev/stderr))"

REMOTE_DIR=""
REMOTE_BACKUP_ROOT=""
REMOTE_DIR_COUNT=0
REMOTE_BACKUP_ROOT_COUNT=0
while IFS='=' read -r path_key path_value; do
  case "${path_key}" in
    REMOTE_DIR)
      REMOTE_DIR_COUNT=$((REMOTE_DIR_COUNT + 1))
      [[ "${REMOTE_DIR_COUNT}" -eq 1 ]] \
        || fail "remote path response must contain REMOTE_DIR exactly once."
      REMOTE_DIR="${path_value}"
      ;;
    REMOTE_BACKUP_ROOT)
      REMOTE_BACKUP_ROOT_COUNT=$((REMOTE_BACKUP_ROOT_COUNT + 1))
      [[ "${REMOTE_BACKUP_ROOT_COUNT}" -eq 1 ]] \
        || fail "remote path response must contain REMOTE_BACKUP_ROOT exactly once."
      REMOTE_BACKUP_ROOT="${path_value}"
      ;;
    *)
      fail "remote path response contained an unexpected key."
      ;;
  esac
done <<< "${REMOTE_PATH_STATE}"
[[ "${REMOTE_DIR_COUNT}" -eq 1 && "${REMOTE_BACKUP_ROOT_COUNT}" -eq 1 ]] \
  || fail "remote deployment paths must each be returned exactly once."
validate_canonical_remote_path "${REMOTE_DIR}" "canonical ATLAS_DIR"
validate_canonical_remote_path "${REMOTE_BACKUP_ROOT}" "canonical ATLAS_BACKUP_ROOT"
if path_is_equal_or_descendant "${REMOTE_BACKUP_ROOT}" "${REMOTE_DIR}"; then
  fail "canonical ATLAS_BACKUP_ROOT must be outside the synchronized ATLAS_DIR tree."
fi

ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
  "${REMOTE_DIR}" "${REMOTE_BACKUP_ROOT}" <<'REMOTE_MKDIR'
set -euo pipefail
mkdir -p -- "$1" "$2"
REMOTE_MKDIR

run_remote_preflight() {
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${REMOTE_DIR}" "${REMOTE_BACKUP_ROOT}" <<'REMOTE_PREFLIGHT'
set -euo pipefail

remote_dir="$1"
backup_root="$2"
previous_commit="none"
exact_backup="none"

if [[ -f "${remote_dir}/.atlas-release" ]]; then
  previous_commit="$(tr -d '[:space:]' < "${remote_dir}/.atlas-release")"
fi

if docker volume inspect atlas-db >/dev/null 2>&1; then
  [[ -x "${remote_dir}/deploy/backup.sh" ]] \
    || { echo "Existing Atlas V2 database found, but the remote backup script is unavailable." >&2; exit 1; }
  grep -Fxq 'ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"' "${remote_dir}/deploy/backup.sh" \
    || { echo "Existing Atlas V2 database found, but the remote backup script is not the V2 PostgreSQL backup tool." >&2; exit 1; }
  [[ "${previous_commit}" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "Existing Atlas V2 database has no valid recorded release commit; refusing replacement." >&2; exit 1; }

  backup_output="$({
    cd "${remote_dir}"
    BACKUP_ROOT="${backup_root}" \
      COMPOSE_PROJECT_NAME="atlas-v2" \
      ATLAS_GIT_COMMIT="${previous_commit}" \
      ./deploy/backup.sh
  })"
  [[ "$(printf '%s\n' "${backup_output}" | wc -l | tr -d '[:space:]')" == "1" ]] \
    || { echo "Backup script did not emit exactly one machine-readable path." >&2; exit 1; }
  case "${backup_output}" in
    ATLAS_BACKUP_PATH=*) exact_backup="${backup_output#ATLAS_BACKUP_PATH=}" ;;
    *) echo "Backup script did not emit ATLAS_BACKUP_PATH." >&2; exit 1 ;;
  esac

  exact_backup="$(realpath -m -- "${exact_backup}")"
  backup_root="$(realpath -m -- "${backup_root}")"
  case "${exact_backup}" in
    "${backup_root}"/*) ;;
    *) echo "Backup path escaped the configured backup root." >&2; exit 1 ;;
  esac
  for backup_file in atlas-postgres.dump atlas-artifacts.tgz metadata.txt manifest.sha256; do
    [[ -s "${exact_backup}/${backup_file}" ]] \
      || { echo "Exact backup is incomplete: ${backup_file}." >&2; exit 1; }
  done
  (cd "${exact_backup}" && sha256sum --check manifest.sha256) >&2

  if [[ ! -x "${remote_dir}/deploy/restore-test.sh" ]]; then
    echo "Existing Atlas V2 database found, but the non-destructive restore test is unavailable." >&2
    echo "Deployment stopped before source sync or migration." >&2
    echo "No rollback was run automatically." >&2
    echo "Previous Git commit: ${previous_commit}" >&2
    echo "Exact pre-deploy backup: ${exact_backup}" >&2
    exit 1
  fi
  if ! (
    cd "${remote_dir}"
    ./deploy/restore-test.sh "${exact_backup}"
  ) >&2; then
    echo "Fresh pre-deploy backup failed its non-destructive restore test." >&2
    echo "Deployment stopped before source sync or migration." >&2
    echo "No rollback was run automatically." >&2
    echo "Previous Git commit: ${previous_commit}" >&2
    echo "Exact pre-deploy backup: ${exact_backup}" >&2
    exit 1
  fi
  echo "Fresh pre-deploy backup passed its non-destructive restore test: ${exact_backup}" >&2
fi

printf 'PREVIOUS_COMMIT=%s\n' "${previous_commit}"
printf 'EXACT_BACKUP=%s\n' "${exact_backup}"
REMOTE_PREFLIGHT
}

# Back up only the explicitly named V2 volumes before source or containers change.
REMOTE_STATE="$(run_remote_preflight 2> >(tee /dev/stderr))"

PREVIOUS_COMMIT="none"
EXACT_BACKUP="none"
while IFS='=' read -r state_key state_value; do
  case "${state_key}" in
    PREVIOUS_COMMIT) PREVIOUS_COMMIT="${state_value}" ;;
    EXACT_BACKUP) EXACT_BACKUP="${state_value}" ;;
  esac
done <<< "${REMOTE_STATE}"
[[ "${PREVIOUS_COMMIT}" == "none" || "${PREVIOUS_COMMIT}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "remote preflight returned an invalid previous commit."
[[ "${EXACT_BACKUP}" == "none" || "${EXACT_BACKUP}" == "${REMOTE_BACKUP_ROOT}/"* ]] \
  || fail "remote preflight returned an invalid backup path."

GUIDANCE_PRINTED=0
print_recovery_guidance() {
  local failure_status="$1"
  [[ "${GUIDANCE_PRINTED}" -eq 0 ]] || return 0
  GUIDANCE_PRINTED=1
  {
    echo "Atlas V2 deployment failed with status ${failure_status}."
    echo "No rollback was run automatically."
    echo "Previous Git commit: ${PREVIOUS_COMMIT}"
    echo "Exact pre-deploy backup: ${EXACT_BACKUP}"
    echo "Manual recovery: inspect the failed services and backup manifest before creating a clean worktree at the previous commit or performing any operator-reviewed restore."
  } >&2
}
on_deploy_error() {
  local failure_status="$?"
  print_recovery_guidance "${failure_status}"
  return "${failure_status}"
}
on_deploy_exit() {
  local failure_status="$?"
  if [[ "${failure_status}" -ne 0 ]]; then
    print_recovery_guidance "${failure_status}"
  fi
}
trap on_deploy_error ERR
trap on_deploy_exit EXIT

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

rsync -az --chmod=F600 -e "${RSYNC_RSH}" \
  "${ENV_FILE}" "${REMOTE_TARGET}:${REMOTE_DIR}/.env"

ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- "${REMOTE_DIR}" <<'REMOTE_DEPLOY'
set -euo pipefail

remote_dir="$1"
cd "${remote_dir}"

docker compose config >/dev/null
docker compose build web
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

docker compose run --rm web npm run db:migrate
docker compose up -d web worker caddy
docker compose up -d --wait --wait-timeout 180
docker compose ps
REMOTE_DEPLOY

TARGET_HEALTH_RESPONSE="$({
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- <<'REMOTE_HEALTH'
set -euo pipefail
curl --fail --silent --show-error \
  --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
  --noproxy '*' \
  --resolve atlas.rangeway.app:443:127.0.0.1 \
  https://atlas.rangeway.app/api/v2/health
REMOTE_HEALTH
})"
HEALTH_JSON="${TARGET_HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2") {
    throw new Error("Target-bound Atlas health response did not report apiVersion=v2.");
  }
'

PUBLIC_HEALTH_RESPONSE="$({
  curl --fail --silent --show-error \
    --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
    https://atlas.rangeway.app/api/v2/health
})"
HEALTH_JSON="${PUBLIC_HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2") {
    throw new Error("Public Atlas health response did not report apiVersion=v2.");
  }
'

ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
  "${REMOTE_DIR}" "${LOCAL_COMMIT}" <<'REMOTE_RELEASE'
set -euo pipefail
remote_dir="$1"
release_commit="$2"
[[ "${release_commit}" =~ ^[0-9a-f]{40}$ ]] || exit 1
umask 077
printf '%s\n' "${release_commit}" > "${remote_dir}/.atlas-release.next"
mv -- "${remote_dir}/.atlas-release.next" "${remote_dir}/.atlas-release"
REMOTE_RELEASE

trap - ERR EXIT
echo "Atlas V2 release ${LOCAL_COMMIT} passed target-bound and public HTTPS health verification."
echo "No rollback was run automatically."
echo "Previous Git commit: ${PREVIOUS_COMMIT}"
echo "Exact pre-deploy backup: ${EXACT_BACKUP}"
if [[ "${PREVIOUS_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Rollback guidance: create a clean worktree at ${PREVIOUS_COMMIT}, review it, and run this deploy script from that worktree."
else
  echo "Rollback guidance: no previous Atlas V2 Git commit was recorded; do not attempt an automated code rollback."
fi
if [[ "${EXACT_BACKUP}" != "none" ]]; then
  echo "Data rollback guidance: first verify ${EXACT_BACKUP} with deploy/restore-test.sh, then restore only through an operator-reviewed procedure."
else
  echo "Data rollback guidance: no pre-deploy Atlas V2 backup exists because this was the first V2 database release."
fi
