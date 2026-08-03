#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${REPOSITORY_ROOT}"

REMOTE_HOST="${ATLAS_HOST:-}"
REMOTE_USER="${ATLAS_USER:-root}"
REMOTE_DIR="${ATLAS_DIR:-/opt/atlas-v2}"
REMOTE_BACKUP_ROOT="${ATLAS_BACKUP_ROOT:-${REMOTE_DIR}/backups}"
ENV_FILE="${ATLAS_ENV_FILE:-}"
SSH_KEY="${ATLAS_SSH_KEY:-}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSYNC_RSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

fail() {
  echo "Atlas V2 deployment refused: $*" >&2
  exit 1
}

validate_remote_path() {
  local candidate="$1"
  local label="$2"
  [[ "${candidate}" == /* ]] || fail "${label} must be an absolute path."
  [[ "${candidate}" != "/" ]] || fail "${label} cannot be the filesystem root."
  [[ "${candidate}" != *".."* ]] || fail "${label} cannot contain '..'."
  [[ "${candidate}" != *'*'* && "${candidate}" != *'?'* && "${candidate}" != *'['* ]] \
    || fail "${label} cannot contain a glob."
  [[ "${candidate}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "${label} contains unsupported characters."
}

[[ -n "${REMOTE_HOST}" ]] || fail "set ATLAS_HOST to the target VPS hostname or IP."
[[ "${REMOTE_HOST}" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "ATLAS_HOST contains unsupported characters."
[[ "${REMOTE_USER}" =~ ^[A-Za-z0-9._-]+$ ]] || fail "ATLAS_USER contains unsupported characters."
validate_remote_path "${REMOTE_DIR}" "ATLAS_DIR"
validate_remote_path "${REMOTE_BACKUP_ROOT}" "ATLAS_BACKUP_ROOT"

[[ -n "${ENV_FILE}" ]] || fail "set ATLAS_ENV_FILE to the production environment file."
[[ -f "${ENV_FILE}" ]] || fail "production environment file not found: ${ENV_FILE}"
if grep -q "REPLACE_WITH" "${ENV_FILE}"; then
  fail "production environment file still contains REPLACE_WITH placeholders."
fi
for required_key in POSTGRES_PASSWORD DATABASE_URL SESSION_SECRET ATLAS_ORIGIN AUTH_MODE; do
  grep -Eq "^${required_key}=.+$" "${ENV_FILE}" \
    || fail "production environment file is missing ${required_key}."
done
grep -Eq '^DATABASE_URL=postgres(ql)?://[^@]+@db:5432/atlas(\?.*)?$' "${ENV_FILE}" \
  || fail "DATABASE_URL must target the Compose service db:5432/atlas."

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
ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" \
  "mkdir -p -- '${REMOTE_DIR}' '${REMOTE_BACKUP_ROOT}'"

# Back up only the explicitly named V2 volumes before source or containers change.
REMOTE_STATE="$({
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" bash -s -- \
    "${REMOTE_DIR}" "${REMOTE_BACKUP_ROOT}" <<'REMOTE_PREFLIGHT'
set -euo pipefail

remote_dir="$1"
backup_root="$2"
previous_commit="none"
latest_backup="none"

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

  (
    cd "${remote_dir}"
    BACKUP_ROOT="${backup_root}" \
      COMPOSE_PROJECT_NAME="atlas-v2" \
      ATLAS_GIT_COMMIT="${previous_commit}" \
      ./deploy/backup.sh
  ) >&2

  latest_backup="$(
    find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -name '20*' -print \
      | LC_ALL=C sort \
      | tail -n 1
  )"
  [[ -n "${latest_backup}" ]] || { echo "Backup completed without a discoverable backup directory." >&2; exit 1; }
fi

printf 'PREVIOUS_COMMIT=%s\n' "${previous_commit}"
printf 'LATEST_BACKUP=%s\n' "${latest_backup}"
REMOTE_PREFLIGHT
} 2> >(tee /dev/stderr))"

PREVIOUS_COMMIT="none"
LATEST_BACKUP="none"
while IFS='=' read -r state_key state_value; do
  case "${state_key}" in
    PREVIOUS_COMMIT) PREVIOUS_COMMIT="${state_value}" ;;
    LATEST_BACKUP) LATEST_BACKUP="${state_value}" ;;
  esac
done <<< "${REMOTE_STATE}"

rsync -az --delete-delay \
  -e "${RSYNC_RSH}" \
  --exclude ".git/" \
  --exclude ".env" \
  --exclude ".atlas-release" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "backups/" \
  --exclude "artifacts/" \
  --exclude "atlas-db/" \
  --exclude "atlas-artifacts/" \
  --exclude "data/" \
  --exclude "uploads/" \
  ./ "${REMOTE_TARGET}:${REMOTE_DIR}/"

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

HEALTH_RESPONSE="$(
  curl --fail --silent --show-error \
    --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
    https://atlas.rangeway.app/api/v2/health
)"
HEALTH_JSON="${HEALTH_RESPONSE}" node --input-type=module -e '
  const health = JSON.parse(process.env.HEALTH_JSON ?? "null");
  if (health?.apiVersion !== "v2") {
    throw new Error("Atlas health response did not report apiVersion=v2.");
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

echo "Atlas V2 release ${LOCAL_COMMIT} passed HTTPS health verification."
echo "No rollback was run automatically."
echo "Previous Git commit: ${PREVIOUS_COMMIT}"
echo "Latest pre-deploy backup: ${LATEST_BACKUP}"
if [[ "${PREVIOUS_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Rollback guidance: create a clean worktree at ${PREVIOUS_COMMIT}, review it, and run this deploy script from that worktree."
else
  echo "Rollback guidance: no previous Atlas V2 Git commit was recorded; do not attempt an automated code rollback."
fi
if [[ "${LATEST_BACKUP}" != "none" ]]; then
  echo "Data rollback guidance: first verify ${LATEST_BACKUP} with deploy/restore-test.sh, then restore only through an operator-reviewed procedure."
else
  echo "Data rollback guidance: no pre-deploy Atlas V2 backup exists because this was the first V2 database release."
fi
