#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/atlas-backups}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-atlas}"
DATA_VOLUME="${ATLAS_DATA_VOLUME:-${COMPOSE_PROJECT_NAME}_crm-data}"
UPLOADS_VOLUME="${ATLAS_UPLOADS_VOLUME:-${COMPOSE_PROJECT_NAME}_crm-uploads}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"

mkdir -p "${BACKUP_DIR}"

for volume in "${DATA_VOLUME}" "${UPLOADS_VOLUME}"; do
  if ! docker volume inspect "${volume}" >/dev/null 2>&1; then
    echo "Atlas volume not found: ${volume}" >&2
    echo "Set COMPOSE_PROJECT_NAME or ATLAS_DATA_VOLUME/ATLAS_UPLOADS_VOLUME if this deployment uses custom names." >&2
    exit 1
  fi
done

docker run --rm \
  -v "${DATA_VOLUME}:/data:ro" \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/atlas-data-${STAMP}.tgz" -C /data .

docker run --rm \
  -v "${UPLOADS_VOLUME}:/uploads:ro" \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/atlas-uploads-${STAMP}.tgz" -C /uploads .

echo "Backups written to ${BACKUP_DIR}"
