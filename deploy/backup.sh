#!/usr/bin/env bash
set -euo pipefail

ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"
BACKUP_ROOT_INPUT="${BACKUP_ROOT:-/var/backups/atlas-v2}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-atlas-v2}"
REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  echo "Atlas V2 backup refused: $*" >&2
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

[[ "${BACKUP_ROOT_INPUT}" != *'*'* && "${BACKUP_ROOT_INPUT}" != *'?'* && "${BACKUP_ROOT_INPUT}" != *'['* ]] \
  || fail "BACKUP_ROOT cannot contain a glob."
LEXICAL_BACKUP_ROOT="$(canonicalize_absolute_path "${BACKUP_ROOT_INPUT}")" \
  || fail "BACKUP_ROOT must be an absolute path."

if [[ -e "${LEXICAL_BACKUP_ROOT}" ]]; then
  [[ -d "${LEXICAL_BACKUP_ROOT}" ]] || fail "BACKUP_ROOT must resolve to a directory."
  BACKUP_ROOT="$(cd -- "${LEXICAL_BACKUP_ROOT}" && pwd -P)"
else
  BACKUP_PARENT="${LEXICAL_BACKUP_ROOT%/*}"
  BACKUP_BASENAME="${LEXICAL_BACKUP_ROOT##*/}"
  [[ -n "${BACKUP_PARENT}" ]] || BACKUP_PARENT="/"
  [[ -d "${BACKUP_PARENT}" ]] || fail "BACKUP_ROOT parent must already exist: ${BACKUP_PARENT}"
  BACKUP_PARENT="$(cd -- "${BACKUP_PARENT}" && pwd -P)"
  BACKUP_ROOT="${BACKUP_PARENT%/}/${BACKUP_BASENAME}"
fi

[[ "${BACKUP_ROOT}" != "/" ]] || fail "BACKUP_ROOT cannot resolve to the filesystem root."
if [[ -n "${HOME:-}" && "${BACKUP_ROOT}" == "${HOME}" ]]; then
  fail "BACKUP_ROOT cannot resolve to the user home directory."
fi
case "${BACKUP_ROOT}" in
  "${REPOSITORY_ROOT}"|"${REPOSITORY_ROOT}"/*)
    fail "BACKUP_ROOT must resolve outside the Atlas source directory."
    ;;
esac
[[ "${BACKUP_ROOT}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "BACKUP_ROOT contains unsupported characters."

for command_name in docker sha256sum mktemp git; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

cd "${REPOSITORY_ROOT}"
docker compose config >/dev/null

DB_CONTAINER="$(docker compose ps -q db)"
[[ -n "${DB_CONTAINER}" ]] || fail "the Compose database service is not running."
[[ "$(docker inspect --format '{{.State.Running}}' "${DB_CONTAINER}")" == "true" ]] \
  || fail "the Compose database container is not running."
docker volume inspect atlas-artifacts >/dev/null 2>&1 \
  || fail "the Atlas V2 artifact volume does not exist."

GIT_COMMIT="${ATLAS_GIT_COMMIT:-}"
if [[ -z "${GIT_COMMIT}" && -f .atlas-release ]]; then
  GIT_COMMIT="$(tr -d '[:space:]' < .atlas-release)"
fi
if [[ -z "${GIT_COMMIT}" ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_COMMIT="$(git rev-parse --verify HEAD)"
fi
[[ "${GIT_COMMIT}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "ATLAS_GIT_COMMIT or .atlas-release must identify the deployed commit."

DATABASE_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${DB_CONTAINER}")"
[[ -n "${DATABASE_IMAGE}" ]] || fail "could not resolve the database image."
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p -- "${BACKUP_ROOT}"
BACKUP_ROOT="$(cd -- "${BACKUP_ROOT}" && pwd -P)"
PENDING_DIR="$(mktemp -d "${BACKUP_ROOT}/.atlas-backup-${STAMP}.XXXXXX")"
BACKUP_SUFFIX="${PENDING_DIR##*.}"
FINAL_DIR="${BACKUP_ROOT}/${STAMP}-${BACKUP_SUFFIX}"
[[ ! -e "${FINAL_DIR}" ]] || fail "backup destination already exists: ${FINAL_DIR}"

WEB_WAS_RUNNING=0
WORKER_WAS_RUNNING=0
[[ -n "$(docker compose ps --status running -q web)" ]] && WEB_WAS_RUNNING=1
[[ -n "$(docker compose ps --status running -q worker)" ]] && WORKER_WAS_RUNNING=1
RESTORE_SERVICES=1

restart_app_services() {
  local restart_status=0
  set +e
  if [[ "${WORKER_WAS_RUNNING}" -eq 1 ]]; then
    docker compose start worker >&2 || restart_status=1
  fi
  if [[ "${WEB_WAS_RUNNING}" -eq 1 ]]; then
    docker compose start web >&2 || restart_status=1
  fi
  set -e
  return "${restart_status}"
}

restart_on_exit() {
  local original_status="$?"
  local restart_status=0
  trap - EXIT INT TERM
  if [[ "${RESTORE_SERVICES}" -eq 1 ]]; then
    restart_app_services || restart_status="$?"
  fi
  [[ "${original_status}" -ne 0 ]] && exit "${original_status}"
  exit "${restart_status}"
}
trap restart_on_exit EXIT INT TERM

if [[ "${WEB_WAS_RUNNING}" -eq 1 ]]; then
  docker compose stop web >&2
fi
if [[ "${WORKER_WAS_RUNNING}" -eq 1 ]]; then
  docker compose stop worker >&2
fi

docker compose exec -T db \
  pg_dump --format=custom --username=atlas --dbname=atlas \
  > "${PENDING_DIR}/atlas-postgres.dump"

docker run --rm \
  --volume atlas-artifacts:/artifacts:ro \
  --volume "${PENDING_DIR}:/backup" \
  alpine:3.21 \
  tar -C /artifacts -czf /backup/atlas-artifacts.tgz .

[[ -s "${PENDING_DIR}/atlas-postgres.dump" ]] \
  || fail "atlas-postgres.dump is empty."
[[ -s "${PENDING_DIR}/atlas-artifacts.tgz" ]] \
  || fail "atlas-artifacts.tgz is empty."

{
  printf 'backup_format=%s\n' "${ATLAS_BACKUP_FORMAT}"
  printf 'git_commit=%s\n' "${GIT_COMMIT}"
  printf 'compose_project=%s\n' "${COMPOSE_PROJECT_NAME}"
  printf 'database_image=%s\n' "${DATABASE_IMAGE}"
  printf 'timestamp=%s\n' "${TIMESTAMP}"
} > "${PENDING_DIR}/metadata.txt"

(
  cd "${PENDING_DIR}"
  sha256sum atlas-postgres.dump atlas-artifacts.tgz metadata.txt > manifest.sha256
)
[[ -s "${PENDING_DIR}/manifest.sha256" ]] || fail "manifest.sha256 is empty."

restart_app_services || fail "one or more app services could not be restarted after backup."
RESTORE_SERVICES=0
trap - EXIT INT TERM

mv -- "${PENDING_DIR}" "${FINAL_DIR}"
printf 'ATLAS_BACKUP_PATH=%s\n' "${FINAL_DIR}"
