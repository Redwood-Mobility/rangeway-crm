#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Atlas V2 restore test refused: $*" >&2
  exit 1
}

DEPLOYMENT_TOKEN="${ATLAS_DEPLOYMENT_TOKEN:-}"
if [[ -n "${DEPLOYMENT_TOKEN}" ]]; then
  [[ "${DEPLOYMENT_TOKEN}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || fail "ATLAS_DEPLOYMENT_TOKEN is invalid."
  [[ "${PGAPPNAME:-}" == "atlas-deploy-${DEPLOYMENT_TOKEN}" ]] \
    || fail "PGAPPNAME must identify the exact Atlas deployment token."
else
  PGAPPNAME="atlas-restore-test"
fi

[[ "$#" -eq 1 ]] || fail "exactly one BACKUP_DIRECTORY is required."
BACKUP_INPUT="$1"
[[ -n "${BACKUP_INPUT}" ]] || fail "BACKUP_DIRECTORY cannot be empty."
[[ "${BACKUP_INPUT}" != *'*'* && "${BACKUP_INPUT}" != *'?'* && "${BACKUP_INPUT}" != *'['* ]] \
  || fail "BACKUP_DIRECTORY cannot contain an unresolved glob."

case "${BACKUP_INPUT}" in
  /|~|'$HOME'|atlas-db|atlas-artifacts)
    fail "unsafe BACKUP_DIRECTORY target: ${BACKUP_INPUT}"
    ;;
esac

[[ -d "${BACKUP_INPUT}" ]] || fail "BACKUP_DIRECTORY does not exist: ${BACKUP_INPUT}"
BACKUP_DIR="$(cd -- "${BACKUP_INPUT}" && pwd -P)"
BACKUP_BASENAME="${BACKUP_DIR##*/}"
[[ "${BACKUP_DIR}" != "/" ]] || fail "unsafe resolved BACKUP_DIRECTORY: /"
if [[ -n "${HOME:-}" && "${BACKUP_DIR}" == "${HOME}" ]]; then
  fail "unsafe resolved BACKUP_DIRECTORY: user home"
fi
case "${BACKUP_BASENAME}" in
  atlas-db|atlas-artifacts) fail "BACKUP_DIRECTORY cannot use a live Atlas V2 volume name." ;;
esac

for filename in atlas-postgres.dump atlas-artifacts.tgz manifest.sha256 metadata.txt; do
  [[ -s "${BACKUP_DIR}/${filename}" ]] || fail "required backup file is missing or empty: ${filename}"
done

for command_name in sha256sum awk sort docker mktemp rmdir; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

MANIFEST_FILES="$(
  awk '{ filename=$2; sub(/^\*/, "", filename); print filename }' "${BACKUP_DIR}/manifest.sha256" \
    | LC_ALL=C sort
)"
EXPECTED_FILES="$(printf '%s\n' atlas-artifacts.tgz atlas-postgres.dump metadata.txt | LC_ALL=C sort)"
[[ "${MANIFEST_FILES}" == "${EXPECTED_FILES}" ]] \
  || fail "manifest.sha256 must list exactly the database, artifact, and metadata files."
(
  cd "${BACKUP_DIR}"
  sha256sum --check manifest.sha256
) || fail "backup checksum verification failed."

RESTORE_TMP_ROOT="${ATLAS_RESTORE_TMP_ROOT:-/tmp}"
[[ "${RESTORE_TMP_ROOT}" == /* && "${RESTORE_TMP_ROOT}" != "/" && -d "${RESTORE_TMP_ROOT}" ]] \
  || fail "ATLAS_RESTORE_TMP_ROOT must be an existing absolute directory other than /."
[[ "${RESTORE_TMP_ROOT}" != *'*'* && "${RESTORE_TMP_ROOT}" != *'?'* && "${RESTORE_TMP_ROOT}" != *'['* ]] \
  || fail "ATLAS_RESTORE_TMP_ROOT cannot contain a glob."
RESTORE_WORKDIR="$(mktemp -d "${RESTORE_TMP_ROOT%/}/atlas-restore-test.XXXXXX")"
RUN_TOKEN="$(basename -- "${RESTORE_WORKDIR}" | tr -cd 'A-Za-z0-9_')_$$"
TEMP_DB_VOLUME="atlas_restore_db_${RUN_TOKEN}"
TEMP_ARTIFACT_VOLUME="atlas_restore_artifacts_${RUN_TOKEN}"
TEMP_DB_CONTAINER="atlas_restore_postgres_${RUN_TOKEN}"
TEMP_ARTIFACT_CONTAINER="atlas_restore_files_${RUN_TOKEN}"
TEMP_PASSWORD="atlas_restore_${RUN_TOKEN}"
DB_VOLUME_CREATED=0
ARTIFACT_VOLUME_CREATED=0

cleanup_resources() {
  local cleanup_status=0
  set +e

  docker rm -f "${TEMP_ARTIFACT_CONTAINER}" >/dev/null 2>&1 || true
  docker rm -f "${TEMP_DB_CONTAINER}" >/dev/null 2>&1 || true
  if [[ "${ARTIFACT_VOLUME_CREATED}" -eq 1 ]]; then
    docker volume rm "${TEMP_ARTIFACT_VOLUME}" >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ "${DB_VOLUME_CREATED}" -eq 1 ]]; then
    docker volume rm "${TEMP_DB_VOLUME}" >/dev/null 2>&1 || cleanup_status=1
  fi
  rmdir -- "${RESTORE_WORKDIR}" >/dev/null 2>&1 || cleanup_status=1

  set -e
  return "${cleanup_status}"
}

cleanup_on_exit() {
  local original_status="$?"
  local cleanup_status=0
  trap - EXIT INT TERM

  cleanup_resources || cleanup_status="$?"
  [[ "${original_status}" -ne 0 ]] && exit "${original_status}"
  exit "${cleanup_status}"
}
trap cleanup_on_exit EXIT INT TERM

docker volume create --label atlas.restore-test=true "${TEMP_DB_VOLUME}" >/dev/null
DB_VOLUME_CREATED=1
docker volume create --label atlas.restore-test=true "${TEMP_ARTIFACT_VOLUME}" >/dev/null
ARTIFACT_VOLUME_CREATED=1

docker run --rm --name "${TEMP_ARTIFACT_CONTAINER}" \
  --volume "${TEMP_ARTIFACT_VOLUME}:/artifacts" \
  --volume "${BACKUP_DIR}:/backup:ro" \
  alpine:3.21 \
  tar -C /artifacts -xzf /backup/atlas-artifacts.tgz

docker run --detach --name "${TEMP_DB_CONTAINER}" \
  --env POSTGRES_USER=atlas_restore \
  --env "POSTGRES_PASSWORD=${TEMP_PASSWORD}" \
  --env POSTGRES_DB=atlas_restore \
  --volume "${TEMP_DB_VOLUME}:/var/lib/postgresql/data" \
  postgres:17-bookworm >/dev/null

for _attempt in $(seq 1 60); do
  if docker exec "${TEMP_DB_CONTAINER}" \
    pg_isready --username=atlas_restore --dbname=atlas_restore >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${TEMP_DB_CONTAINER}" \
  pg_isready --username=atlas_restore --dbname=atlas_restore >/dev/null \
  || fail "temporary PostgreSQL did not become ready."

docker exec -i "${TEMP_DB_CONTAINER}" \
  env "PGAPPNAME=${PGAPPNAME}" \
  pg_restore --username=atlas_restore --dbname=atlas_restore --no-owner --no-privileges \
  < "${BACKUP_DIR}/atlas-postgres.dump"

MIGRATION_COUNT="$(
  docker exec "${TEMP_DB_CONTAINER}" env "PGAPPNAME=${PGAPPNAME}" psql \
    --username=atlas_restore --dbname=atlas_restore --tuples-only --no-align \
    --command="SELECT count(*) FROM schema_migrations WHERE filename = '0001_platform.sql';"
)"
[[ "${MIGRATION_COUNT}" == "1" ]] \
  || fail "restored database did not contain the expected schema_migrations row."

ORGANIZATION_COUNT="$(
  docker exec "${TEMP_DB_CONTAINER}" env "PGAPPNAME=${PGAPPNAME}" psql \
    --username=atlas_restore --dbname=atlas_restore --tuples-only --no-align \
    --command="SELECT count(*) FROM organizations WHERE id = '00000000-0000-4000-8000-000000000001';"
)"
[[ "${ORGANIZATION_COUNT}" == "1" ]] \
  || fail "restored database did not contain the immutable Rangeway organization ID."

trap - EXIT INT TERM
cleanup_resources || fail "temporary restore-test resources could not all be removed."
echo "Restore test passed for ${BACKUP_DIR}."
echo "Verified schema migration row, immutable Rangeway organization ID, and artifact archive extraction."
