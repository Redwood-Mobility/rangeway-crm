#!/usr/bin/env bash
set -euo pipefail

# Host-wide, boot-reconciled deployment ownership for Atlas V2. The durable
# state file is deliberately parsed as data; it is never sourced as shell code.
UNIT_NAME="atlas-v2-deployment-guardian.service"
STATE_ROOT="/var/lib/atlas-v2-deployment"
CONFIG_FILE="/etc/atlas-v2-deployment-guardian.conf"
GLOBAL_LOCK="/run/lock/atlas-v2-deployment.lock"
COMPOSE_PROJECT="atlas-v2"

if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
  STATE_ROOT="${ATLAS_COORDINATOR_STATE_ROOT:-${STATE_ROOT}}"
  CONFIG_FILE="${ATLAS_COORDINATOR_CONFIG_FILE:-${CONFIG_FILE}}"
  GLOBAL_LOCK="${ATLAS_COORDINATOR_GLOBAL_LOCK:-${GLOBAL_LOCK}}"
fi

ACTIVE_STATE="${STATE_ROOT}/active.state"
STATE_LOCK="${STATE_ROOT}/state.lock"
HISTORY_ROOT="${STATE_ROOT}/history"

die() {
  echo "Atlas deployment coordinator refused: $*" >&2
  exit 1
}

now_epoch() {
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" && -n "${ATLAS_COORDINATOR_NOW_EPOCH:-}" ]]; then
    printf '%s\n' "${ATLAS_COORDINATOR_NOW_EPOCH}"
  else
    date +%s
  fi
}

valid_token() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

valid_commit() {
  [[ "$1" == "none" || "$1" =~ ^[0-9a-f]{40}$ ]]
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

durable_publish() {
  local destination="$1"
  local mode="$2"
  python3 -c '
import os
import secrets
import sys

destination, mode_text, fault = sys.argv[1:4]
directory = os.path.dirname(destination)
basename = os.path.basename(destination)
temporary = os.path.join(directory, f".{basename}.tmp.{os.getpid()}.{secrets.token_hex(8)}")
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
file_descriptor = None
try:
    file_descriptor = os.open(temporary, flags, int(mode_text, 8))
    data = sys.stdin.buffer.read()
    view = memoryview(data)
    while view:
        written = os.write(file_descriptor, view)
        view = view[written:]
    os.fchmod(file_descriptor, int(mode_text, 8))
    os.fsync(file_descriptor)
    if fault == "after-file-fsync":
        os._exit(86)
    os.close(file_descriptor)
    file_descriptor = None
    os.replace(temporary, destination)
    if fault == "after-rename":
        os._exit(87)
    directory_descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
except BaseException:
    if file_descriptor is not None:
        os.close(file_descriptor)
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
' "${destination}" "${mode}" "${ATLAS_COORDINATOR_FAULT:-}"
}

durable_move() {
  local source="$1"
  local destination="$2"
  python3 -c '
import os
import sys

source, destination = sys.argv[1:3]
if os.path.exists(destination):
    raise FileExistsError(destination)
source_descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    os.fsync(source_descriptor)
finally:
    os.close(source_descriptor)
os.replace(source, destination)
for directory in dict.fromkeys((os.path.dirname(source), os.path.dirname(destination))):
    directory_descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
' "${source}" "${destination}"
}

prepare_state_root() {
  umask 077
  mkdir -p -- "${STATE_ROOT}" "${HISTORY_ROOT}"
  chmod 0700 "${STATE_ROOT}" "${HISTORY_ROOT}"
  : > "${STATE_LOCK}"
  chmod 0600 "${STATE_LOCK}"
}

reset_state_variables() {
  token=""
  status=""
  remote_dir=""
  backup_root=""
  previous_commit=""
  exact_backup=""
  web_container=""
  worker_container=""
  lease_seconds=""
  deadline_epoch=""
  guardian_ack_token=""
  release_commit=""
}

read_state() {
  local state_file="${1:-${ACTIVE_STATE}}"
  local key value
  local seen="|"
  reset_state_variables
  [[ -f "${state_file}" ]] || return 2
  while IFS='=' read -r key value; do
    [[ -n "${key}" && "${seen}" != *"|${key}|"* ]] || return 1
    seen="${seen}${key}|"
    case "${key}" in
      token) token="${value}" ;;
      status) status="${value}" ;;
      remote_dir) remote_dir="${value}" ;;
      backup_root) backup_root="${value}" ;;
      previous_commit) previous_commit="${value}" ;;
      exact_backup) exact_backup="${value}" ;;
      web_container) web_container="${value}" ;;
      worker_container) worker_container="${value}" ;;
      lease_seconds) lease_seconds="${value}" ;;
      deadline_epoch) deadline_epoch="${value}" ;;
      guardian_ack_token) guardian_ack_token="${value}" ;;
      release_commit) release_commit="${value}" ;;
      *) return 1 ;;
    esac
  done < "${state_file}"

  valid_token "${token}" || return 1
  case "${status}" in
    prepared|quiesced|boundary|recovered|recovery_failed|failed_closed|complete) ;;
    *) return 1 ;;
  esac
  valid_path "${remote_dir}" || return 1
  valid_path "${backup_root}" || return 1
  path_is_equal_or_descendant "${backup_root}" "${remote_dir}" && return 1
  valid_commit "${previous_commit}" || return 1
  [[ "${exact_backup}" == "none" ]] || valid_path "${exact_backup}" || return 1
  [[ "${web_container}" == "none" || "${web_container}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  [[ "${worker_container}" == "none" || "${worker_container}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  [[ "${lease_seconds}" =~ ^[0-9]+$ && "${lease_seconds}" -ge 2 && "${lease_seconds}" -le 900 ]] || return 1
  [[ "${deadline_epoch}" =~ ^[0-9]+$ ]] || return 1
  [[ "${guardian_ack_token}" == "none" || "${guardian_ack_token}" == "${token}" ]] || return 1
  valid_commit "${release_commit}" || return 1
}

write_state() {
  local destination="${1:-${ACTIVE_STATE}}"
  umask 077
  {
    printf 'token=%s\n' "${token}"
    printf 'status=%s\n' "${status}"
    printf 'remote_dir=%s\n' "${remote_dir}"
    printf 'backup_root=%s\n' "${backup_root}"
    printf 'previous_commit=%s\n' "${previous_commit}"
    printf 'exact_backup=%s\n' "${exact_backup}"
    printf 'web_container=%s\n' "${web_container}"
    printf 'worker_container=%s\n' "${worker_container}"
    printf 'lease_seconds=%s\n' "${lease_seconds}"
    printf 'deadline_epoch=%s\n' "${deadline_epoch}"
    printf 'guardian_ack_token=%s\n' "${guardian_ack_token}"
    printf 'release_commit=%s\n' "${release_commit}"
  } | durable_publish "${destination}" 0600
}

write_config() {
  umask 077
  mkdir -p -- "$(dirname -- "${CONFIG_FILE}")"
  printf 'REMOTE_DIR=%s\n' "${remote_dir}" | durable_publish "${CONFIG_FILE}" 0600
}

configured_remote_dir() {
  local key value extra
  [[ -f "${CONFIG_FILE}" ]] || return 1
  IFS='=' read -r key value < "${CONFIG_FILE}"
  IFS= read -r extra < <(sed -n '2p' "${CONFIG_FILE}") || true
  [[ "${key}" == "REMOTE_DIR" && -n "${value}" && -z "${extra:-}" ]] || return 1
  valid_path "${value}" || return 1
  printf '%s\n' "${value}"
}

stop_all_writers() {
  local target="$1"
  local service snapshot line container project_label service_label extra
  local -a containers=()
  valid_path "${target}" || return 1
  for service in web worker migrator; do
    snapshot="$(docker ps \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=${service}" \
      --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')"
    while IFS= read -r line; do
      [[ -n "${line}" ]] || continue
      IFS='|' read -r container project_label service_label extra <<< "${line}"
      [[ "${container}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
      [[ "${project_label}" == "${COMPOSE_PROJECT}" && "${service_label}" == "${service}" ]] || return 1
      [[ -z "${extra:-}" && "${line}" == *"|"*"|"* ]] || return 1
      containers+=("${container}")
    done <<< "${snapshot}"
  done
  if [[ "${#containers[@]}" -gt 0 ]]; then
    docker stop -- "${containers[@]}" >/dev/null
  fi
}

restore_exact_writers() {
  local failed=0
  stop_all_writers "${remote_dir}" || failed=1
  if [[ "${worker_container}" != "none" ]]; then
    docker start "${worker_container}" >/dev/null || failed=1
  fi
  if [[ "${web_container}" != "none" ]]; then
    docker start "${web_container}" >/dev/null || failed=1
  fi
  return "${failed}"
}

snapshot_writers() {
  local snapshot line service state container extra
  web_container="none"
  worker_container="none"
  snapshot="$(cd -- "${remote_dir}" && docker compose ps --all --format '{{.Service}}|{{.State}}|{{.ID}}')"
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    IFS='|' read -r service state container extra <<< "${line}"
    [[ -n "${service}" && -n "${state}" && -n "${container}" && -z "${extra:-}" \
      && "${line}" == *"|"*"|"* ]] \
      || die "writer snapshot was malformed."
    [[ "${container}" =~ ^[A-Za-z0-9_.-]+$ ]] || die "writer snapshot contained an invalid container ID."
    case "${state}" in
      running|restarting)
        case "${service}" in
          web) [[ "${web_container}" == "none" ]] || die "writer snapshot contained duplicate web services."; web_container="${container}" ;;
          worker) [[ "${worker_container}" == "none" ]] || die "writer snapshot contained duplicate worker services."; worker_container="${container}" ;;
          *) ;;
        esac
        ;;
      created|exited|paused|dead|removing) ;;
      *) die "writer snapshot contained an unsupported state." ;;
    esac
  done <<< "${snapshot}"
}

read_release_commit() {
  local release_file="${remote_dir}/.atlas-release"
  previous_commit="none"
  if [[ -f "${release_file}" ]]; then
    IFS= read -r previous_commit < "${release_file}" || true
    valid_commit "${previous_commit}" || die "existing release marker is malformed."
  fi
}

archive_stale_state() {
  local suffix="$1"
  durable_move "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.${suffix}.state"
}

begin_deployment() {
  local requested_token="$1"
  local requested_remote="$2"
  local requested_backup="$3"
  local requested_lease="$4"
  local current_now canonical_remote canonical_backup
  valid_token "${requested_token}" || die "deployment token is invalid."
  valid_path "${requested_remote}" || die "remote directory is invalid."
  valid_path "${requested_backup}" || die "backup root is invalid."
  path_is_equal_or_descendant "${requested_backup}" "${requested_remote}" \
    && die "backup root must remain outside the release directory."
  [[ "${requested_lease}" =~ ^[0-9]+$ && "${requested_lease}" -ge 2 && "${requested_lease}" -le 900 ]] \
    || die "lease must be between 2 and 900 seconds."
  [[ -d "${requested_remote}" ]] || die "remote directory must already exist."
  [[ -d "${requested_backup}" ]] || die "backup root must already exist."
  canonical_remote="$(realpath "${requested_remote}")"
  canonical_backup="$(realpath "${requested_backup}")"
  [[ "${canonical_remote}" == "${requested_remote}" ]] \
    || die "remote directory must be its exact canonical path."
  [[ "${canonical_backup}" == "${requested_backup}" ]] \
    || die "backup root must be its exact canonical path."

  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  if [[ -e "${ACTIVE_STATE}" ]]; then
    if ! read_state; then
      die "durable state is malformed; operator resolution is required."
    fi
    case "${status}" in
      complete|recovered) archive_stale_state "stale-${status}" ;;
      recovery_failed|failed_closed) die "prior recovery requires operator resolution before a new deployment." ;;
      *) die "a deployment already active under token ${token}." ;;
    esac
  fi

  token="${requested_token}"
  status="prepared"
  remote_dir="${requested_remote}"
  backup_root="${requested_backup}"
  previous_commit="none"
  exact_backup="none"
  lease_seconds="${requested_lease}"
  current_now="$(now_epoch)"
  deadline_epoch="$((current_now + lease_seconds))"
  guardian_ack_token="none"
  release_commit="none"
  snapshot_writers
  read_release_commit
  write_state
  write_config
  flock -u 8

  systemctl enable --now "${UNIT_NAME}" >/dev/null
  systemctl restart "${UNIT_NAME}" >/dev/null
  systemctl is-active --quiet "${UNIT_NAME}" || die "deployment guardian is not active."

  local attempts=0
  while [[ "${attempts}" -lt 50 ]]; do
    exec 8>"${STATE_LOCK}"
    flock -s 8
    if read_state && [[ "${token}" == "${requested_token}" && "${guardian_ack_token}" == "${requested_token}" ]]; then
      printf 'TOKEN=%s\n' "${token}"
      printf 'REMOTE_DIR=%s\n' "${remote_dir}"
      printf 'REMOTE_BACKUP_ROOT=%s\n' "${backup_root}"
      printf 'PREVIOUS_COMMIT=%s\n' "${previous_commit}"
      printf 'WEB_CONTAINER=%s\n' "${web_container}"
      printf 'WORKER_CONTAINER=%s\n' "${worker_container}"
      flock -u 8
      return 0
    fi
    flock -u 8
    attempts=$((attempts + 1))
    sleep 0.1
  done
  die "deployment guardian did not acknowledge the exact ownership token."
}

mutate_state() {
  local requested_token="$1"
  local operation="$2"
  local expected="${3:-}"
  local replacement="${4:-}"
  local current_now
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" ]] || die "deployment ownership token does not match."
  current_now="$(now_epoch)"
  case "${operation}" in
    transition)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      [[ "${status}" == "${expected}" ]] || die "expected deployment state ${expected}, found ${status}."
      case "${expected}:${replacement}" in
        prepared:quiesced|quiesced:boundary) ;;
        *) die "invalid deployment state transition." ;;
      esac
      status="${replacement}"
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    renew)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      [[ -z "${expected}" || "${status}" == "${expected}" ]] \
        || die "expected deployment state ${expected}, found ${status}."
      case "${status}" in prepared|quiesced|boundary) ;; *) die "deployment lease cannot be renewed in ${status}." ;; esac
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    annotate)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      valid_commit "${expected}" || die "previous release commit is invalid."
      valid_path "${replacement}" || die "exact backup path is invalid."
      path_is_equal_or_descendant "${replacement}" "${backup_root}" || die "exact backup is outside the backup root."
      previous_commit="${expected}"
      exact_backup="${replacement}"
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    candidate)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      [[ "${status}" == "quiesced" ]] || die "release candidate can only be recorded while quiesced."
      valid_commit "${expected}" || die "release candidate commit is invalid."
      [[ "${expected}" != "none" ]] || die "release candidate commit is required."
      release_commit="${expected}"
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    fail)
      case "${status}" in complete|recovered) die "completed ownership cannot fail." ;; esac
      deadline_epoch=0
      ;;
    *) die "unknown state operation." ;;
  esac
  write_state
  flock -u 8
}

assert_deployment() {
  local requested_token="$1"
  local expected_status="$2"
  local current_now
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" ]] || die "deployment ownership token does not match."
  [[ "${status}" == "${expected_status}" ]] \
    || die "expected deployment state ${expected_status}, found ${status}."
  current_now="$(now_epoch)"
  [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
  flock -u 8
}

run_guarded_action_command() {
  local action="$1"
  case "${action}" in
    backup)
      local backup_output backup_path backup_file
      backup_path="none"
      if docker volume inspect atlas-db >/dev/null 2>&1; then
        [[ -x deploy/backup.sh ]] || die "existing Atlas V2 database found, but backup.sh is unavailable."
        grep -Fxq 'ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"' deploy/backup.sh \
          || die "existing database backup tool has an unsupported format."
        backup_output="$(BACKUP_ROOT="${backup_root}" COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT}" \
          ATLAS_GIT_COMMIT="${previous_commit}" ATLAS_KEEP_QUIESCED=1 ./deploy/backup.sh)"
        [[ "$(printf '%s\n' "${backup_output}" | wc -l | tr -d '[:space:]')" == "1" ]] \
          || die "backup script did not emit exactly one machine-readable path."
        case "${backup_output}" in
          ATLAS_BACKUP_PATH=*) backup_path="${backup_output#ATLAS_BACKUP_PATH=}" ;;
          *) die "backup script did not emit ATLAS_BACKUP_PATH." ;;
        esac
        backup_path="$(realpath -m -- "${backup_path}")"
        path_is_equal_or_descendant "${backup_path}" "${backup_root}" \
          || die "backup escaped its configured root."
        for backup_file in atlas-postgres.dump atlas-artifacts.tgz metadata.txt manifest.sha256; do
          [[ -s "${backup_path}/${backup_file}" ]] || die "exact backup is incomplete: ${backup_file}."
        done
        (cd -- "${backup_path}" && sha256sum --check manifest.sha256) >&2
      else
        stop_all_writers "${remote_dir}"
      fi
      printf 'EXACT_BACKUP=%s\n' "${backup_path}"
      ;;
    restore-backup)
      [[ "${exact_backup}" != "none" ]] || die "exact backup is required for restore testing."
      [[ -x deploy/restore-test.sh ]] || die "non-destructive restore test is unavailable."
      ./deploy/restore-test.sh "${exact_backup}"
      ;;
    build-db)
      docker compose config >/dev/null
      docker compose build web worker
      docker compose run --rm --no-deps web node --input-type=module -e \
        "import('./dist/server/config.js')"
      docker compose run --rm --no-deps worker node --input-type=module -e \
        "import('./dist/worker/config.js').then(({parseWorkerConfig}) => parseWorkerConfig(process.env))"
      docker compose run --rm --no-deps migrator node --input-type=module -e \
        "import('./dist/server/platform/db/migrate.js').then(({readMigrationDatabaseUrl}) => readMigrationDatabaseUrl(process.env))"
      docker compose up -d db
      local db_container db_health
      db_container="$(docker compose ps -q db)"
      [[ -n "${db_container}" ]] || die "Atlas V2 database container did not start."
      for _attempt in $(seq 1 60); do
        db_health="$(docker inspect --format '{{.State.Health.Status}}' "${db_container}")"
        [[ "${db_health}" == "healthy" ]] && break
        [[ "${db_health}" != "unhealthy" ]] || {
          docker compose logs db >&2
          return 1
        }
        /bin/sleep 2
      done
      [[ "$(docker inspect --format '{{.State.Health.Status}}' "${db_container}")" == "healthy" ]] || {
        echo "Atlas V2 database did not become healthy." >&2
        docker compose logs db >&2
        return 1
      }
      ;;
    rotate-roles)
      docker compose exec -T db /docker-entrypoint-initdb.d/001-atlas-roles.sh
      ;;
    migrate)
      docker compose --profile operations run --rm migrator
      ;;
    start-writers)
      docker compose up -d web worker caddy
      docker compose up -d --wait --wait-timeout 180
      docker compose ps
      ;;
    verify-contract)
      docker compose exec -T db psql --username=atlas --dbname=atlas \
        --variable=ON_ERROR_STOP=1 --tuples-only --no-align <<'SQL'
DO $contract$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public'
       AND c.relname = ANY (ARRAY[
         'schema_migrations', 'organizations', 'users', 'actors',
         'organization_memberships', 'audit_events', 'outbox_events',
         'api_idempotency_keys'
       ])
       AND r.rolname <> 'atlas_migrator'
  ) THEN
    RAISE EXCEPTION 'Atlas migration-managed relation ownership contract failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname = 'atlas_reject_audit_mutation'
       AND r.rolname = 'atlas_migrator'
  ) THEN
    RAISE EXCEPTION 'Atlas audit guard ownership contract failed';
  END IF;
  IF NOT (
    has_table_privilege('atlas_web', 'public.organizations', 'SELECT')
    AND has_table_privilege('atlas_web', 'public.audit_events', 'INSERT')
    AND NOT has_table_privilege('atlas_web', 'public.schema_migrations', 'SELECT')
    AND has_table_privilege('atlas_worker', 'public.outbox_events', 'SELECT')
    AND has_column_privilege('atlas_worker', 'public.outbox_events', 'attempt_count', 'UPDATE')
    AND NOT has_column_privilege('atlas_worker', 'public.outbox_events', 'payload', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'Atlas application role permission contract failed';
  END IF;
END
$contract$;
SELECT 'atlas-v2-foundation-v1';
SQL
      ;;
    *) die "guarded deployment action is invalid." ;;
  esac
}

guard_deployment_action() {
  local requested_token="$1"
  local expected_status="$2"
  local action="$3"
  local required_status current_now child_pid heartbeat_pid action_status heartbeat_interval
  case "${action}" in
    backup|restore-backup) required_status="prepared" ;;
    build-db) required_status="quiesced" ;;
    rotate-roles|migrate|start-writers|verify-contract) required_status="boundary" ;;
    *) die "guarded deployment action is invalid." ;;
  esac
  [[ "${expected_status}" == "${required_status}" ]] \
    || die "guarded deployment action has an invalid phase."

  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" ]] || die "deployment ownership token does not match."
  [[ "${status}" == "${expected_status}" ]] \
    || die "expected deployment state ${expected_status}, found ${status}."
  current_now="$(now_epoch)"
  [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
  deadline_epoch="$((current_now + lease_seconds))"
  write_state

  (
    cd -- "${remote_dir}"
    if [[ "${release_commit}" != "none" ]]; then
      export ATLAS_IMAGE_TAG="${release_commit}"
      export ATLAS_RELEASE_SHA="${release_commit}"
    fi
    run_guarded_action_command "${action}"
  ) &
  child_pid="$!"
  flock -u 8

  # One-second heartbeats keep the kill/wait path bounded even for the maximum
  # 15-minute lease and leave ample margin for the minimum two-second lease.
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
    heartbeat_interval=0.05
  else
    heartbeat_interval=1
  fi
  (
    while /bin/sleep "${heartbeat_interval}"; do
      kill -0 "${child_pid}" 2>/dev/null || exit 0
      exec 7>"${STATE_LOCK}"
      flock -x 7
      if ! read_state \
        || [[ "${token}" != "${requested_token}" ]] \
        || [[ "${status}" != "${expected_status}" ]]; then
        flock -u 7
        kill -TERM "${child_pid}" 2>/dev/null || true
        exit 1
      fi
      current_now="$(now_epoch)"
      if [[ "${deadline_epoch}" -le "${current_now}" ]]; then
        flock -u 7
        kill -TERM "${child_pid}" 2>/dev/null || true
        exit 1
      fi
      deadline_epoch="$((current_now + lease_seconds))"
      write_state
      flock -u 7
    done
  ) &
  heartbeat_pid="$!"

  set +e
  wait "${child_pid}"
  action_status="$?"
  kill -TERM "${heartbeat_pid}" 2>/dev/null || true
  wait "${heartbeat_pid}" 2>/dev/null || true
  set -e
  assert_deployment "${requested_token}" "${expected_status}"
  return "${action_status}"
}

reconcile_once() {
  local current_now configured
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  if [[ ! -e "${ACTIVE_STATE}" ]]; then
    flock -u 8
    return 0
  fi
  if ! read_state; then
    configured="$(configured_remote_dir)" || {
      flock -u 8
      echo "Atlas deployment coordinator could not recover malformed state without a valid config." >&2
      return 1
    }
    stop_all_writers "${configured}" || true
    flock -u 8
    echo "Atlas deployment coordinator failed closed because durable state was malformed." >&2
    return 1
  fi

  if [[ "${guardian_ack_token}" != "${token}" ]]; then
    guardian_ack_token="${token}"
    write_state
  fi
  current_now="$(now_epoch)"
  if [[ "${status}" == "failed_closed" ]]; then
    stop_all_writers "${remote_dir}" || true
    write_state
    flock -u 8
    return 0
  fi
  if [[ "${deadline_epoch}" -gt "${current_now}" ]]; then
    flock -u 8
    return 0
  fi

  case "${status}" in
    prepared|quiesced|recovery_failed)
      if restore_exact_writers; then
        status="recovered"
        write_state
        flock -u 8
        return 0
      fi
      status="recovery_failed"
      write_state
      flock -u 8
      echo "Atlas deployment coordinator could not restore the exact prior writer set." >&2
      return 1
      ;;
    boundary)
      stop_all_writers "${remote_dir}" || true
      status="failed_closed"
      write_state
      flock -u 8
      return 0
      ;;
    complete|recovered)
      flock -u 8
      return 0
      ;;
    *)
      flock -u 8
      return 1
      ;;
  esac
}

guardian_once() {
  mkdir -p -- "$(dirname -- "${GLOBAL_LOCK}")"
  exec 9>"${GLOBAL_LOCK}"
  flock -n 9 || die "another deployment guardian owns the host-wide reconciliation lock."
  reconcile_once
}

guardian_loop() {
  mkdir -p -- "$(dirname -- "${GLOBAL_LOCK}")"
  exec 9>"${GLOBAL_LOCK}"
  flock -n 9 || die "another deployment guardian owns the host-wide reconciliation lock."
  while true; do
    reconcile_once || true
    sleep 1
  done
}

complete_deployment() {
  local requested_token="$1"
  local requested_commit="$2"
  local current_now
  valid_commit "${requested_commit}" || die "release commit is invalid."
  [[ "${requested_commit}" != "none" ]] || die "release commit is required."
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" ]] || die "deployment ownership token does not match."
  [[ "${status}" == "boundary" ]] || die "only a boundary deployment can be completed."
  [[ "${release_commit}" == "${requested_commit}" ]] || die "release commit does not match the guarded candidate."
  current_now="$(now_epoch)"
  [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."

  umask 077
  printf '%s\n' "${requested_commit}" | durable_publish "${remote_dir}/.atlas-release" 0600

  release_commit="${requested_commit}"
  status="complete"
  write_state
  durable_move "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.complete.state"
  flock -u 8
  systemctl disable --now "${UNIT_NAME}" >/dev/null
}

usage() {
  echo "usage: $0 begin|transition|renew|assert|annotate|candidate|guard|fail|complete|guardian|guardian-once ..." >&2
  exit 64
}

command="${1:-}"
case "${command}" in
  begin) [[ "$#" -eq 5 ]] || usage; begin_deployment "$2" "$3" "$4" "$5" ;;
  transition) [[ "$#" -eq 4 ]] || usage; mutate_state "$2" transition "$3" "$4" ;;
  renew) [[ "$#" -eq 3 ]] || usage; mutate_state "$2" renew "$3" ;;
  assert) [[ "$#" -eq 3 ]] || usage; assert_deployment "$2" "$3" ;;
  annotate) [[ "$#" -eq 4 ]] || usage; mutate_state "$2" annotate "$3" "$4" ;;
  candidate) [[ "$#" -eq 3 ]] || usage; mutate_state "$2" candidate "$3" ;;
  guard) [[ "$#" -eq 4 ]] || usage; guard_deployment_action "$2" "$3" "$4" ;;
  fail)
    [[ "$#" -eq 2 ]] || usage
    mutate_state "$2" fail
    systemctl restart "${UNIT_NAME}" >/dev/null
    ;;
  complete) [[ "$#" -eq 3 ]] || usage; complete_deployment "$2" "$3" ;;
  guardian) [[ "$#" -eq 1 ]] || usage; guardian_loop ;;
  guardian-once) [[ "$#" -eq 1 ]] || usage; guardian_once ;;
  *) usage ;;
esac
