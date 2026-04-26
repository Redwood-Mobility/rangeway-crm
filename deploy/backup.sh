#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/atlas-backups}"
STAMP="$(date +%Y-%m-%d-%H%M%S)"

mkdir -p "${BACKUP_DIR}"

docker run --rm \
  -v rangeway-crm_crm-data:/data:ro \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/atlas-data-${STAMP}.tgz" -C /data .

docker run --rm \
  -v rangeway-crm_crm-uploads:/uploads:ro \
  -v "${BACKUP_DIR}:/backup" \
  alpine tar czf "/backup/atlas-uploads-${STAMP}.tgz" -C /uploads .

echo "Backups written to ${BACKUP_DIR}"
