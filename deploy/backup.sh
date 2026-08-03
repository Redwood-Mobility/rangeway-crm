#!/usr/bin/env bash
set -euo pipefail

ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"
UNRELEASED_PROVENANCE="unreleased-v2-foundation"
BACKUP_ROOT_INPUT="${BACKUP_ROOT:-/var/backups/atlas-v2}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-atlas-v2}"
DB_VOLUME_NAME="${ATLAS_DB_VOLUME_NAME:-atlas-db}"
ARTIFACT_VOLUME_NAME="${ATLAS_ARTIFACT_VOLUME_NAME:-atlas-artifacts}"
KEEP_QUIESCED="${ATLAS_KEEP_QUIESCED:-0}"
BACKUP_TEST_MODE="${ATLAS_BACKUP_TEST_MODE:-0}"
REPOSITORY_ROOT_INPUT="${ATLAS_REPOSITORY_ROOT:-}"

if [[ "${1:-}" == "--repository-root" ]]; then
  [[ "$#" -eq 2 ]] || { echo "Atlas V2 backup refused: --repository-root requires exactly one path." >&2; exit 1; }
  [[ -z "${REPOSITORY_ROOT_INPUT}" || "${REPOSITORY_ROOT_INPUT}" == "$2" ]] \
    || { echo "Atlas V2 backup refused: repository-root inputs disagree." >&2; exit 1; }
  REPOSITORY_ROOT_INPUT="$2"
elif [[ "$#" -ne 0 ]]; then
  echo "Atlas V2 backup refused: usage: $0 [--repository-root ABSOLUTE_PATH]" >&2
  exit 1
fi

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

[[ "${BACKUP_TEST_MODE}" == "0" || "${BACKUP_TEST_MODE}" == "1" ]] \
  || fail "ATLAS_BACKUP_TEST_MODE must be 0 or 1."
[[ "${COMPOSE_PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
  || fail "COMPOSE_PROJECT_NAME is invalid."
[[ "${DB_VOLUME_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fail "ATLAS_DB_VOLUME_NAME is invalid."
[[ "${ARTIFACT_VOLUME_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fail "ATLAS_ARTIFACT_VOLUME_NAME is invalid."
[[ "${DB_VOLUME_NAME}" != "${ARTIFACT_VOLUME_NAME}" ]] \
  || fail "database and artifact volume names must be distinct."
if [[ "${BACKUP_TEST_MODE}" != "1" ]]; then
  [[ "${COMPOSE_PROJECT_NAME}" == "atlas-v2" ]] \
    || fail "production Docker project must be exactly atlas-v2."
  [[ "${DB_VOLUME_NAME}" == "atlas-db" ]] \
    || fail "production database volume must be exactly atlas-db."
  [[ "${ARTIFACT_VOLUME_NAME}" == "atlas-artifacts" ]] \
    || fail "production artifact volume must be exactly atlas-artifacts."
fi
[[ -n "${REPOSITORY_ROOT_INPUT}" ]] \
  || fail "ATLAS_REPOSITORY_ROOT or --repository-root is required."
[[ "${REPOSITORY_ROOT_INPUT}" != *'*'* && "${REPOSITORY_ROOT_INPUT}" != *'?'* \
  && "${REPOSITORY_ROOT_INPUT}" != *'['* ]] \
  || fail "repository root cannot contain a glob."
LEXICAL_REPOSITORY_ROOT="$(canonicalize_absolute_path "${REPOSITORY_ROOT_INPUT}")" \
  || fail "repository root must be an absolute path."
[[ "${LEXICAL_REPOSITORY_ROOT}" == "${REPOSITORY_ROOT_INPUT}" ]] \
  || fail "repository root must be an exact canonical absolute path."
if [[ "${BACKUP_TEST_MODE}" != "1" ]]; then
  [[ "${LEXICAL_REPOSITORY_ROOT}" == "/opt/atlas-v2" ]] \
    || fail "production repository root must be exactly /opt/atlas-v2."
fi
[[ -d "${LEXICAL_REPOSITORY_ROOT}" && ! -L "${LEXICAL_REPOSITORY_ROOT}" ]] \
  || fail "repository root must be a real directory."
REPOSITORY_ROOT="$(cd -- "${LEXICAL_REPOSITORY_ROOT}" && pwd -P)"
[[ "${REPOSITORY_ROOT}" == "${LEXICAL_REPOSITORY_ROOT}" ]] \
  || fail "repository root must not traverse a symlink."

[[ "${BACKUP_ROOT_INPUT}" != *'*'* && "${BACKUP_ROOT_INPUT}" != *'?'* && "${BACKUP_ROOT_INPUT}" != *'['* ]] \
  || fail "BACKUP_ROOT cannot contain a glob."
[[ "${KEEP_QUIESCED}" == "0" || "${KEEP_QUIESCED}" == "1" ]] \
  || fail "ATLAS_KEEP_QUIESCED must be 0 or 1."
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

for command_name in docker sha256sum mktemp git rm; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

GIT_COMMIT="${ATLAS_GIT_COMMIT:-}"
if [[ -z "${GIT_COMMIT}" && -f "${REPOSITORY_ROOT}/.atlas-release" ]]; then
  GIT_COMMIT="$(tr -d '[:space:]' < "${REPOSITORY_ROOT}/.atlas-release")"
fi
if [[ -z "${GIT_COMMIT}" ]] \
  && git -C "${REPOSITORY_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_COMMIT="$(git -C "${REPOSITORY_ROOT}" rev-parse --verify HEAD)"
fi
MIGRATION_PROVENANCE="released"
MIGRATION_SET_SHA256="none"
if [[ "${GIT_COMMIT}" == "${UNRELEASED_PROVENANCE}" ]]; then
  [[ ! -e "${REPOSITORY_ROOT}/.atlas-release" ]] \
    || fail "unreleased provenance requires that no release marker existed."
  MIGRATION_SET_SHA256="${ATLAS_INITIAL_PROVENANCE_SHA256:-}"
  [[ "${MIGRATION_SET_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "unreleased provenance requires an immutable migration-set identity."
  MIGRATION_PROVENANCE="zero"
else
  [[ "${GIT_COMMIT}" =~ ^[0-9a-f]{40}$ ]] \
    || fail "ATLAS_GIT_COMMIT or .atlas-release must identify the deployed commit."
fi

DISCOVERED_CONTAINER="none"
discover_single_running_service() {
  local service="$1"
  local required="$2"
  local snapshot line candidate project_label service_label extra
  DISCOVERED_CONTAINER="none"
  snapshot="$(docker ps \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')" \
    || fail "could not inspect the exact-label ${service} service."
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    IFS='|' read -r candidate project_label service_label extra <<< "${line}"
    [[ "${candidate}" =~ ^[A-Za-z0-9_.-]+$ && -z "${extra:-}" \
      && "${line}" == *"|"*"|"* ]] \
      || fail "exact-label ${service} discovery returned malformed output."
    [[ "${project_label}" == "${COMPOSE_PROJECT_NAME}" && "${service_label}" == "${service}" ]] \
      || fail "exact-label ${service} discovery returned mismatched labels."
    [[ "${DISCOVERED_CONTAINER}" == "none" ]] \
      || fail "exact-label ${service} discovery returned duplicate running containers."
    DISCOVERED_CONTAINER="${candidate}"
  done <<< "${snapshot}"
  if [[ "${required}" == "required" && "${DISCOVERED_CONTAINER}" == "none" ]]; then
    fail "the exact-label ${service} service is not running."
  fi
}

docker volume inspect "${DB_VOLUME_NAME}" >/dev/null 2>&1 \
  || fail "the Atlas V2 database volume does not exist."
docker volume inspect "${ARTIFACT_VOLUME_NAME}" >/dev/null 2>&1 \
  || fail "the Atlas V2 artifact volume does not exist."

discover_single_running_service db required
DB_CONTAINER="${DISCOVERED_CONTAINER}"
DB_MOUNT="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Name}}|{{.Destination}}{{"\n"}}{{end}}{{end}}' "${DB_CONTAINER}")"
[[ "${DB_MOUNT}" == "volume|${DB_VOLUME_NAME}|/var/lib/postgresql/data" ]] \
  || fail "the exact-label database container is not attached to the expected database volume."

DATABASE_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${DB_CONTAINER}")"
[[ -n "${DATABASE_IMAGE}" ]] || fail "could not resolve the database image."
if [[ "${MIGRATION_PROVENANCE}" == "zero" ]]; then
  INITIAL_DATABASE_STATE="$(
    docker exec "${DB_CONTAINER}" env \
      "PGAPPNAME=atlas-deploy-${ATLAS_DEPLOYMENT_TOKEN:-standalone-backup}" \
      psql --username=atlas --dbname=atlas --tuples-only --no-align \
      --variable=ON_ERROR_STOP=1 \
      --command="SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY (ARRAY['organizations','users','actors','organization_memberships','audit_events','outbox_events','api_idempotency_keys'])) THEN 'atlas-initial-empty' ELSE 'atlas-initial-unknown' END AS atlas_initial_provenance;"
  )" || fail "could not verify unreleased database provenance."
  [[ "${INITIAL_DATABASE_STATE}" == "atlas-initial-empty" ]] \
    || fail "unreleased provenance is allowed only for an exact zero-migration Atlas database."
fi
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

WEB_WAS_ACTIVE=0
WORKER_WAS_ACTIVE=0
WEB_CONTAINER="none"
WORKER_CONTAINER="none"
discover_single_running_service web optional
WEB_CONTAINER="${DISCOVERED_CONTAINER}"
[[ "${WEB_CONTAINER}" == "none" ]] || WEB_WAS_ACTIVE=1
discover_single_running_service worker optional
WORKER_CONTAINER="${DISCOVERED_CONTAINER}"
[[ "${WORKER_CONTAINER}" == "none" ]] || WORKER_WAS_ACTIVE=1

PENDING_DIR=""
RESTORE_SERVICES=0

restart_app_services() {
  local restart_status=0
  set +e
  if [[ "${WORKER_WAS_ACTIVE}" -eq 1 ]]; then
    docker start -- "${WORKER_CONTAINER}" >&2 || restart_status=1
  fi
  if [[ "${WEB_WAS_ACTIVE}" -eq 1 ]]; then
    docker start -- "${WEB_CONTAINER}" >&2 || restart_status=1
  fi
  set -e
  return "${restart_status}"
}

cleanup_pending_backup() {
  [[ -n "${PENDING_DIR:-}" && -e "${PENDING_DIR}" ]] || return 0
  case "${PENDING_DIR}" in
    "${BACKUP_ROOT}"/.atlas-backup-*)
      rm -rf -- "${PENDING_DIR}"
      ;;
    *)
      echo "Atlas V2 backup cleanup refused an unexpected path: ${PENDING_DIR}" >&2
      return 1
      ;;
  esac
}

restart_on_exit() {
  local original_status="$?"
  local restart_status=0
  local cleanup_status=0
  trap - EXIT INT TERM
  if [[ "${RESTORE_SERVICES}" -eq 1 ]]; then
    restart_app_services || restart_status="$?"
  fi
  cleanup_pending_backup || cleanup_status="$?"
  [[ "${original_status}" -ne 0 ]] && exit "${original_status}"
  [[ "${restart_status}" -ne 0 ]] && exit "${restart_status}"
  exit "${cleanup_status}"
}

mkdir -p -- "${BACKUP_ROOT}"
BACKUP_ROOT="$(cd -- "${BACKUP_ROOT}" && pwd -P)"
PENDING_DIR="$(mktemp -d "${BACKUP_ROOT}/.atlas-backup-${STAMP}.XXXXXX")"
trap restart_on_exit EXIT INT TERM

BACKUP_SUFFIX="${PENDING_DIR##*.}"
FINAL_DIR="${BACKUP_ROOT}/${STAMP}-${BACKUP_SUFFIX}"
[[ ! -e "${FINAL_DIR}" ]] || fail "backup destination already exists: ${FINAL_DIR}"

RESTORE_SERVICES=1

if [[ "${WEB_WAS_ACTIVE}" -eq 1 ]]; then
  docker stop -- "${WEB_CONTAINER}" >&2
fi
if [[ "${WORKER_WAS_ACTIVE}" -eq 1 ]]; then
  docker stop -- "${WORKER_CONTAINER}" >&2
fi

fence_exact_service() {
  local service="$1"
  local snapshot container project_label service_label extra remaining
  local -a containers=()
  snapshot="$(docker ps \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')"
  while IFS='|' read -r container project_label service_label extra; do
    [[ -n "${container}" ]] || continue
    [[ "${container}" =~ ^[A-Za-z0-9_.-]+$ && -z "${extra:-}" ]] \
      || fail "exact-label ${service} fence returned malformed output."
    [[ "${project_label}" == "${COMPOSE_PROJECT_NAME}" && "${service_label}" == "${service}" ]] \
      || fail "exact-label ${service} fence returned mismatched labels."
    containers+=("${container}")
  done <<< "${snapshot}"
  if [[ "${#containers[@]}" -gt 0 ]]; then
    docker stop -- "${containers[@]}" >&2
  fi
  remaining="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=${service}")"
  [[ -z "${remaining}" ]] || fail "exact-label ${service} writer remains active before pg_dump."
}

for fenced_service in web worker migrator; do
  fence_exact_service "${fenced_service}"
done

docker exec "${DB_CONTAINER}" env \
  "PGAPPNAME=atlas-deploy-${ATLAS_DEPLOYMENT_TOKEN:-standalone-backup}" \
  pg_dump --format=custom --username=atlas --dbname=atlas \
  > "${PENDING_DIR}/atlas-postgres.dump"

docker run --rm \
  --volume "${ARTIFACT_VOLUME_NAME}:/artifacts:ro" \
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
  printf 'migration_provenance=%s\n' "${MIGRATION_PROVENANCE}"
  printf 'migration_set_sha256=%s\n' "${MIGRATION_SET_SHA256}"
  printf 'compose_project=%s\n' "${COMPOSE_PROJECT_NAME}"
  printf 'database_image=%s\n' "${DATABASE_IMAGE}"
  printf 'timestamp=%s\n' "${TIMESTAMP}"
  printf 'writers_quiesced=%s\n' "${KEEP_QUIESCED}"
  printf 'web_was_active=%s\n' "${WEB_WAS_ACTIVE}"
  printf 'worker_was_active=%s\n' "${WORKER_WAS_ACTIVE}"
} > "${PENDING_DIR}/metadata.txt"

(
  cd "${PENDING_DIR}"
  sha256sum atlas-postgres.dump atlas-artifacts.tgz metadata.txt > manifest.sha256
)
[[ -s "${PENDING_DIR}/manifest.sha256" ]] || fail "manifest.sha256 is empty."

if [[ "${KEEP_QUIESCED}" -eq 0 ]]; then
  restart_app_services || fail "one or more app services could not be restarted after backup."
fi
RESTORE_SERVICES=0

mv -- "${PENDING_DIR}" "${FINAL_DIR}"
PENDING_DIR=""
trap - EXIT INT TERM
printf 'ATLAS_BACKUP_PATH=%s\n' "${FINAL_DIR}"
