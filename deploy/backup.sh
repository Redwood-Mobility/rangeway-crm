#!/usr/bin/env bash
set -euo pipefail

ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/atlas-v2/backups}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-atlas-v2}"
REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  echo "Atlas V2 backup refused: $*" >&2
  exit 1
}

[[ "${BACKUP_ROOT}" == /* ]] || fail "BACKUP_ROOT must be an absolute path."
[[ "${BACKUP_ROOT}" != "/" ]] || fail "BACKUP_ROOT cannot be the filesystem root."
[[ "${BACKUP_ROOT}" != *'*'* && "${BACKUP_ROOT}" != *'?'* && "${BACKUP_ROOT}" != *'['* ]] \
  || fail "BACKUP_ROOT cannot contain a glob."
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

mv -- "${PENDING_DIR}" "${FINAL_DIR}"
echo "Atlas V2 backup written to ${FINAL_DIR}"
