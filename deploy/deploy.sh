#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${ATLAS_HOST:-}"
REMOTE_USER="${ATLAS_USER:-root}"
REMOTE_DIR="${ATLAS_DIR:-/opt/atlas}"
ENV_FILE="${ATLAS_ENV_FILE:-.env.production}"
SSH_KEY="${ATLAS_SSH_KEY:-}"
SSH_OPTS=()
RSYNC_SSH="ssh"

if [[ -n "${SSH_KEY}" ]]; then
  SSH_OPTS=(-i "${SSH_KEY}")
  RSYNC_SSH="ssh -i ${SSH_KEY}"
fi

if [[ -z "${REMOTE_HOST}" ]]; then
  echo "Set ATLAS_HOST to your VPS IP or hostname." >&2
  echo "Example: ATLAS_HOST=203.0.113.10 ATLAS_USER=root ./deploy/deploy.sh" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} not found. Create it from deploy/env.production.example first." >&2
  echo "Example: cp deploy/env.production.example .env.production" >&2
  exit 1
fi

npm run typecheck

ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p '${REMOTE_DIR}'"

rsync -az --delete \
  -e "${RSYNC_SSH}" \
  --exclude ".git" \
  --exclude ".env" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude "data" \
  --exclude "uploads" \
  ./ "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

rsync -az -e "${RSYNC_SSH}" "${ENV_FILE}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/.env"

ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "cd '${REMOTE_DIR}' && docker compose up -d --build && docker compose ps"

echo "Atlas deployed. Check logs with:"
echo "ssh ${REMOTE_USER}@${REMOTE_HOST} \"cd ${REMOTE_DIR} && docker compose logs -f crm\""
