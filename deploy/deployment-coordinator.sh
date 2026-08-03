#!/usr/bin/env bash
set -euo pipefail

# Host-wide, boot-reconciled deployment ownership for Atlas V2. The durable
# state file is deliberately parsed as data; it is never sourced as shell code.
UNIT_NAME="atlas-v2-deployment-guardian.service"
STATE_ROOT="/var/lib/atlas-v2-deployment"
STAGING_ROOT="/var/lib/atlas-v2-deployment/staging"
CONFIG_FILE="/etc/atlas-v2-deployment-guardian.conf"
GLOBAL_LOCK="/run/lock/atlas-v2-deployment.lock"
INSTALL_LOCK="/run/lock/atlas-v2-deployment-install.lock"
ACTION_CLEANUP_LOCK="/run/lock/atlas-v2-deployment-action-cleanup.lock"
COMPOSE_PROJECT="atlas-v2"
COORDINATOR_PATH="/usr/local/sbin/atlas-v2-deployment-coordinator"
GUARDIAN_UNIT_PATH="/etc/systemd/system/atlas-v2-deployment-guardian.service"
BACKUP_TOOL_PATH="/usr/local/libexec/atlas-v2/backup.sh"
RESTORE_TOOL_PATH="/usr/local/libexec/atlas-v2/restore-test.sh"
ROLE_INITIALIZER_PATH="/usr/local/libexec/atlas-v2/init-roles.sh"
CADDY_CONFIG_PATH="/usr/local/libexec/atlas-v2/Caddyfile"
UNRELEASED_PROVENANCE="unreleased-v2-foundation"

if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
  STATE_ROOT="${ATLAS_COORDINATOR_STATE_ROOT:-${STATE_ROOT}}"
  STAGING_ROOT="${ATLAS_COORDINATOR_STAGE_ROOT:-${STAGING_ROOT}}"
  CONFIG_FILE="${ATLAS_COORDINATOR_CONFIG_FILE:-${CONFIG_FILE}}"
  GLOBAL_LOCK="${ATLAS_COORDINATOR_GLOBAL_LOCK:-${GLOBAL_LOCK}}"
  INSTALL_LOCK="${ATLAS_COORDINATOR_INSTALL_LOCK:-${INSTALL_LOCK}}"
  ACTION_CLEANUP_LOCK="${ATLAS_COORDINATOR_ACTION_CLEANUP_LOCK:-${ACTION_CLEANUP_LOCK}}"
  COORDINATOR_PATH="${ATLAS_COORDINATOR_PATH:-$0}"
  GUARDIAN_UNIT_PATH="${ATLAS_GUARDIAN_UNIT_PATH:-${GUARDIAN_UNIT_PATH}}"
  BACKUP_TOOL_PATH="${ATLAS_BACKUP_TOOL_PATH:-${BACKUP_TOOL_PATH}}"
  RESTORE_TOOL_PATH="${ATLAS_RESTORE_TOOL_PATH:-${RESTORE_TOOL_PATH}}"
  ROLE_INITIALIZER_PATH="${ATLAS_ROLE_INITIALIZER_PATH:-${ROLE_INITIALIZER_PATH}}"
  CADDY_CONFIG_PATH="${ATLAS_CADDY_CONFIG_PATH:-${CADDY_CONFIG_PATH}}"
fi

if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" != "1" && "${EUID}" -ne 0 ]]; then
  echo "Atlas deployment coordinator must run as root." >&2
  exit 1
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

valid_previous_provenance() {
  [[ "$1" == "none" || "$1" == "${UNRELEASED_PROVENANCE}" || "$1" =~ ^[0-9a-f]{40}$ ]]
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

hash_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

validate_bundle_trust() {
  local expected_path expected_hash expected_mode
  while IFS='|' read -r expected_path expected_hash expected_mode; do
    [[ -f "${expected_path}" && ! -L "${expected_path}" ]] \
      || { echo "Atlas immutable deployment bundle file is missing." >&2; return 1; }
    [[ "$(hash_file "${expected_path}")" == "${expected_hash}" ]] \
      || { echo "Atlas immutable deployment bundle hash mismatch." >&2; return 1; }
    if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" != "1" ]]; then
      [[ "$(stat -c '%U:%G:%a' "${expected_path}")" == "root:root:${expected_mode}" ]] \
        || { echo "Atlas immutable deployment bundle ownership or mode mismatch." >&2; return 1; }
    fi
  done <<EOF
${COORDINATOR_PATH}|${coordinator_hash}|755
${GUARDIAN_UNIT_PATH}|${guardian_unit_hash}|644
${BACKUP_TOOL_PATH}|${backup_tool_hash}|755
${RESTORE_TOOL_PATH}|${restore_tool_hash}|755
${ROLE_INITIALIZER_PATH}|${role_initializer_hash}|755
${CADDY_CONFIG_PATH}|${caddy_config_hash}|644
EOF
}

acquire_install_lock() {
  mkdir -p -- "$(dirname -- "${INSTALL_LOCK}")"
  if [[ "${ATLAS_COORDINATOR_INSTALL_LOCK_HELD:-0}" == "1" ]]; then
    flock -n 6 || die "inherited install/acquisition lock is not held."
    return
  fi
  exec 6>"${INSTALL_LOCK}"
  flock -x 6
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

durable_unlink() {
  local target="$1"
  python3 -c '
import os
import sys

target = sys.argv[1]
os.unlink(target)
directory_descriptor = os.open(os.path.dirname(target), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)
' "${target}"
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
  bundle_version=""
  coordinator_hash=""
  guardian_unit_hash=""
  backup_tool_hash=""
  restore_tool_hash=""
  role_initializer_hash=""
  caddy_config_hash=""
  candidate_stage=""
  prior_release_path=""
  release_archive_hash=""
  environment_hash=""
  migration_set_hash=""
  action_name=""
  action_pid=""
  action_phase=""
  action_unit=""
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
      bundle_version) bundle_version="${value}" ;;
      coordinator_hash) coordinator_hash="${value}" ;;
      guardian_unit_hash) guardian_unit_hash="${value}" ;;
      backup_tool_hash) backup_tool_hash="${value}" ;;
      restore_tool_hash) restore_tool_hash="${value}" ;;
      role_initializer_hash) role_initializer_hash="${value}" ;;
      caddy_config_hash) caddy_config_hash="${value}" ;;
      candidate_stage) candidate_stage="${value}" ;;
      prior_release_path) prior_release_path="${value}" ;;
      release_archive_hash) release_archive_hash="${value}" ;;
      environment_hash) environment_hash="${value}" ;;
      migration_set_hash) migration_set_hash="${value}" ;;
      action_name) action_name="${value}" ;;
      action_pid) action_pid="${value}" ;;
      action_phase) action_phase="${value}" ;;
      action_unit) action_unit="${value}" ;;
      *) return 1 ;;
    esac
  done < "${state_file}"

  valid_token "${token}" || return 1
  case "${status}" in
    activating|prepared|quiesced|syncing|synced|boundary|recovered|recovery_failed|failed_closed|complete) ;;
    *) return 1 ;;
  esac
  valid_path "${remote_dir}" || return 1
  valid_path "${backup_root}" || return 1
  path_is_equal_or_descendant "${backup_root}" "${remote_dir}" && return 1
  valid_previous_provenance "${previous_commit}" || return 1
  [[ "${exact_backup}" == "none" ]] || valid_path "${exact_backup}" || return 1
  [[ "${web_container}" == "none" || "${web_container}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  [[ "${worker_container}" == "none" || "${worker_container}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
    [[ "${lease_seconds}" =~ ^[0-9]+$ && "${lease_seconds}" -ge 2 && "${lease_seconds}" -le 900 ]] || return 1
  else
    [[ "${lease_seconds}" =~ ^[0-9]+$ && "${lease_seconds}" -ge 30 && "${lease_seconds}" -le 900 ]] || return 1
  fi
  [[ "${deadline_epoch}" =~ ^[0-9]+$ ]] || return 1
  [[ "${guardian_ack_token}" == "none" || "${guardian_ack_token}" == "${token}" ]] || return 1
  valid_commit "${release_commit}" || return 1
  valid_commit "${bundle_version}" || return 1
  [[ "${bundle_version}" != "none" ]] || return 1
  [[ "${coordinator_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${guardian_unit_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${backup_tool_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${restore_tool_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${role_initializer_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${caddy_config_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  valid_path "${candidate_stage}" || return 1
  [[ "${candidate_stage}" == "${STAGING_ROOT}/${token}" ]] || return 1
  valid_path "${prior_release_path}" || return 1
  [[ "${prior_release_path}" == "${candidate_stage}/previous-release" ]] || return 1
  [[ "${release_archive_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${environment_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${migration_set_hash}" =~ ^[0-9a-f]{64}$ ]] || return 1
  case "${action_name}" in none|backup|restore-backup|sync-release|build-db|rotate-roles|migrate|verify-contract|start-writers|verify-release) ;; *) return 1 ;; esac
  [[ "${action_pid}" == "none" || "${action_pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  case "${action_phase}" in none|prepared|syncing|synced|boundary) ;; *) return 1 ;; esac
  if [[ "${action_unit}" != "none" ]]; then
    [[ "${action_unit}" == "atlas-v2-deploy-${token}-${action_name}.service" ]] || return 1
  fi
  if [[ "${action_name}" == "none" ]]; then
    [[ "${action_pid}" == "none" && "${action_phase}" == "none" && "${action_unit}" == "none" ]] || return 1
  else
    [[ "${action_pid}" != "none" && "${action_phase}" != "none" ]] || return 1
    if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
      [[ "${action_unit}" == "none" ]] || return 1
    else
      [[ "${action_unit}" != "none" ]] || return 1
    fi
  fi
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
    printf 'bundle_version=%s\n' "${bundle_version}"
    printf 'coordinator_hash=%s\n' "${coordinator_hash}"
    printf 'guardian_unit_hash=%s\n' "${guardian_unit_hash}"
    printf 'backup_tool_hash=%s\n' "${backup_tool_hash}"
    printf 'restore_tool_hash=%s\n' "${restore_tool_hash}"
    printf 'role_initializer_hash=%s\n' "${role_initializer_hash}"
    printf 'caddy_config_hash=%s\n' "${caddy_config_hash}"
    printf 'candidate_stage=%s\n' "${candidate_stage}"
    printf 'prior_release_path=%s\n' "${prior_release_path}"
    printf 'release_archive_hash=%s\n' "${release_archive_hash}"
    printf 'environment_hash=%s\n' "${environment_hash}"
    printf 'migration_set_hash=%s\n' "${migration_set_hash}"
    printf 'action_name=%s\n' "${action_name}"
    printf 'action_pid=%s\n' "${action_pid}"
    printf 'action_phase=%s\n' "${action_phase}"
    printf 'action_unit=%s\n' "${action_unit}"
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
  local snapshot line service candidate container project_label service_label extra
  web_container="none"
  worker_container="none"
  for service in web worker migrator; do
    snapshot="$(docker ps \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=${service}" \
      --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')"
    container="none"
    while IFS= read -r line; do
      [[ -n "${line}" ]] || continue
      IFS='|' read -r candidate project_label service_label extra <<< "${line}"
      [[ "${candidate}" =~ ^[A-Za-z0-9_.-]+$ ]] \
        || die "writer snapshot contained an invalid container ID."
      [[ "${project_label}" == "${COMPOSE_PROJECT}" && "${service_label}" == "${service}" \
        && -z "${extra:-}" && "${line}" == *"|"*"|"* ]] \
        || die "writer snapshot label identity was malformed."
      [[ "${container}" == "none" ]] || die "writer snapshot contained duplicate ${service} services."
      container="${candidate}"
    done <<< "${snapshot}"
    case "${service}" in
      web) web_container="${container}" ;;
      worker) worker_container="${container}" ;;
      migrator) [[ "${container}" == "none" ]] || die "an unexpected Atlas migrator is running before deployment ownership." ;;
    esac
  done
}

read_release_commit() {
  local release_file="${remote_dir}/.atlas-release"
  local extra=""
  previous_commit="none"
  if [[ -f "${release_file}" ]]; then
    [[ ! -L "${release_file}" ]] || die "existing release marker must not be a symlink."
    IFS= read -r previous_commit < "${release_file}" || true
    IFS= read -r extra < <(sed -n '2p' "${release_file}") || true
    valid_commit "${previous_commit}" && [[ "${previous_commit}" != "none" && -z "${extra}" ]] \
      || die "existing release marker is malformed."
  elif docker volume inspect atlas-db >/dev/null 2>&1; then
    previous_commit="${UNRELEASED_PROVENANCE}"
  fi
}

release_marker_matches_previous() {
  local tree="$1"
  local marker="${tree}/.atlas-release"
  local value="" extra=""
  if [[ "${previous_commit}" == "none" || "${previous_commit}" == "${UNRELEASED_PROVENANCE}" ]]; then
    [[ ! -e "${marker}" ]]
    return
  fi
  [[ -f "${marker}" && ! -L "${marker}" ]] || return 1
  IFS= read -r value < "${marker}" || return 1
  IFS= read -r extra < <(sed -n '2p' "${marker}") || true
  [[ "${value}" == "${previous_commit}" && -z "${extra}" ]]
}

cleanup_candidate_stage() {
  valid_token "${token}" || return 1
  [[ "${candidate_stage}" == "${STAGING_ROOT}/${token}" ]] || return 1
  if [[ ! -e "${candidate_stage}" ]]; then
    return 0
  fi
  [[ -d "${candidate_stage}" && ! -L "${candidate_stage}" ]] || return 1
  find -P "${candidate_stage}" -depth -delete
  [[ ! -e "${candidate_stage}" ]]
}

tree_is_candidate() {
  local tree="$1"
  local marker="${tree}/.atlas-candidate"
  local value="" extra=""
  [[ -f "${marker}" && ! -L "${marker}" ]] || return 1
  IFS= read -r value < "${marker}" || return 1
  IFS= read -r extra < <(sed -n '2p' "${marker}") || true
  [[ "${value}" == "${bundle_version}" && -z "${extra}" ]]
}

atomic_exchange_directories() {
  local first="$1"
  local second="$2"
  python3 -c '
import ctypes
import errno
import os
import sys

first, second, test_mode = sys.argv[1:4]
RENAME_EXCHANGE = 2
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    if test_mode != "1":
        raise OSError(errno.ENOSYS, "renameat2 is required")
    temporary = first + ".exchange"
    os.rename(second, temporary)
    os.rename(first, second)
    os.rename(temporary, first)
else:
    result = renameat2(-100, os.fsencode(first), -100, os.fsencode(second), RENAME_EXCHANGE)
    if result != 0:
        error = ctypes.get_errno()
        if test_mode == "1" and error in (errno.ENOSYS, errno.EINVAL):
            temporary = first + ".exchange"
            os.rename(second, temporary)
            os.rename(first, second)
            os.rename(temporary, first)
        else:
            raise OSError(error, os.strerror(error))
for directory in dict.fromkeys((os.path.dirname(first), os.path.dirname(second))):
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
' "${first}" "${second}" "${ATLAS_COORDINATOR_TEST_MODE:-0}"
}

restore_prior_release_tree() {
  if tree_is_candidate "${remote_dir}"; then
    [[ -d "${prior_release_path}" && ! -L "${prior_release_path}" ]] || return 1
    release_marker_matches_previous "${prior_release_path}" || return 1
    atomic_exchange_directories "${prior_release_path}" "${remote_dir}" || return 1
  elif release_marker_matches_previous "${remote_dir}"; then
    if [[ -e "${prior_release_path}" ]]; then
      [[ -d "${prior_release_path}" && ! -L "${prior_release_path}" ]] || return 1
      tree_is_candidate "${prior_release_path}" || return 1
    fi
  else
    return 1
  fi
  release_marker_matches_previous "${remote_dir}" || return 1
  [[ ! -e "${remote_dir}/.atlas-candidate" ]] || return 1
}

archive_prior_release_tree() {
  local destination="${HISTORY_ROOT}/${token}.previous-release"
  [[ -d "${prior_release_path}" && ! -L "${prior_release_path}" ]] || return 1
  release_marker_matches_previous "${prior_release_path}" || return 1
  [[ ! -e "${destination}" ]] || return 1
  durable_move "${prior_release_path}" "${destination}"
}

archive_stale_state() {
  local suffix="$1"
  durable_move "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.${suffix}.state"
}

abandon_unacknowledged_begin() {
  local requested_token="$1"
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || { flock -u 8; return 1; }
  [[ "${token}" == "${requested_token}" && "${status}" == "activating" \
    && "${action_name}" == "none" ]] || { flock -u 8; return 1; }
  deadline_epoch=0
  write_state
  flock -u 8

  systemctl disable --now "${UNIT_NAME}" >/dev/null 2>&1 || return 1
  if systemctl is-active --quiet "${UNIT_NAME}"; then
    return 1
  fi

  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || { flock -u 8; return 1; }
  [[ "${token}" == "${requested_token}" && "${status}" == "activating" \
    && "${action_name}" == "none" ]] || { flock -u 8; return 1; }
  release_marker_matches_previous "${remote_dir}" || { flock -u 8; return 1; }
  cleanup_candidate_stage || { flock -u 8; return 1; }
  durable_move "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.begin-failed.state"
  flock -u 8
}

begin_deployment() {
  local requested_token="$1"
  local requested_remote="$2"
  local requested_backup="$3"
  local requested_lease="$4"
  local requested_bundle_version="$5"
  local requested_coordinator_hash="$6"
  local requested_unit_hash="$7"
  local requested_backup_hash="$8"
  local requested_restore_hash="$9"
  local requested_role_initializer_hash="${10}"
  local requested_caddy_config_hash="${11}"
  local requested_stage="${12}"
  local requested_archive_hash="${13}"
  local requested_environment_hash="${14}"
  local requested_migration_set_hash="${15}"
  local current_now canonical_remote canonical_backup
  valid_token "${requested_token}" || die "deployment token is invalid."
  valid_path "${requested_remote}" || die "remote directory is invalid."
  valid_path "${requested_backup}" || die "backup root is invalid."
  path_is_equal_or_descendant "${requested_backup}" "${requested_remote}" \
    && die "backup root must remain outside the release directory."
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
    [[ "${requested_lease}" =~ ^[0-9]+$ && "${requested_lease}" -ge 2 && "${requested_lease}" -le 900 ]] \
      || die "test lease must be between 2 and 900 seconds."
  else
    [[ "${requested_lease}" =~ ^[0-9]+$ && "${requested_lease}" -ge 30 && "${requested_lease}" -le 900 ]] \
      || die "production lease must be between 30 and 900 seconds."
  fi
  valid_commit "${requested_bundle_version}" && [[ "${requested_bundle_version}" != "none" ]] \
    || die "bundle version is invalid."
  for requested_hash in \
    "${requested_coordinator_hash}" "${requested_unit_hash}" \
    "${requested_backup_hash}" "${requested_restore_hash}" \
    "${requested_role_initializer_hash}" "${requested_caddy_config_hash}" \
    "${requested_archive_hash}" "${requested_environment_hash}"; do
    [[ "${requested_hash}" =~ ^[0-9a-f]{64}$ ]] || die "bundle hash is invalid."
  done
  valid_path "${requested_stage}" || die "candidate stage is invalid."
  [[ "${requested_stage}" == "${STAGING_ROOT}/${requested_token}" ]] \
    || die "candidate stage must be the exact token path under the staging root."
  [[ "${requested_migration_set_hash}" =~ ^[0-9a-f]{64}$ ]] \
    || die "migration-set hash is invalid."
  [[ -d "${requested_remote}" ]] || die "remote directory must already exist."
  [[ -d "${requested_backup}" ]] || die "backup root must already exist."
  [[ -d "${requested_stage}" && ! -L "${requested_stage}" ]] || die "candidate stage must already exist."
  canonical_remote="$(realpath "${requested_remote}")"
  canonical_backup="$(realpath "${requested_backup}")"
  [[ "${canonical_remote}" == "${requested_remote}" ]] \
    || die "remote directory must be its exact canonical path."
  [[ "${canonical_backup}" == "${requested_backup}" ]] \
    || die "backup root must be its exact canonical path."

  acquire_install_lock
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  if [[ -e "${ACTIVE_STATE}" ]]; then
    if ! read_state; then
      die "durable state is malformed; operator resolution is required."
    fi
    case "${status}" in
      complete) die "completed ownership remains active until guardian shutdown and archival finish." ;;
      recovered) die "prior recovered ownership must be durably retired before a new deployment." ;;
      recovery_failed|failed_closed) die "prior recovery requires operator resolution before a new deployment." ;;
      *) die "a deployment already active under token ${token}." ;;
    esac
  fi

  token="${requested_token}"
  status="activating"
  remote_dir="${requested_remote}"
  backup_root="${requested_backup}"
  previous_commit="none"
  exact_backup="none"
  lease_seconds="${requested_lease}"
  current_now="$(now_epoch)"
  deadline_epoch="$((current_now + lease_seconds))"
  guardian_ack_token="none"
  release_commit="none"
  bundle_version="${requested_bundle_version}"
  coordinator_hash="${requested_coordinator_hash}"
  guardian_unit_hash="${requested_unit_hash}"
  backup_tool_hash="${requested_backup_hash}"
  restore_tool_hash="${requested_restore_hash}"
  role_initializer_hash="${requested_role_initializer_hash}"
  caddy_config_hash="${requested_caddy_config_hash}"
  candidate_stage="${requested_stage}"
  prior_release_path="${requested_stage}/previous-release"
  release_archive_hash="${requested_archive_hash}"
  environment_hash="${requested_environment_hash}"
  migration_set_hash="${requested_migration_set_hash}"
  action_name="none"
  action_pid="none"
  action_phase="none"
  action_unit="none"
  validate_bundle_trust || die "immutable deployment bundle validation failed."
  snapshot_writers
  read_release_commit
  write_state
  write_config
  flock -u 8

  if ! systemctl enable --now "${UNIT_NAME}" >/dev/null \
    || ! systemctl restart "${UNIT_NAME}" >/dev/null \
    || ! systemctl is-active --quiet "${UNIT_NAME}"; then
    abandon_unacknowledged_begin "${requested_token}" || true
    die "deployment guardian activation failed before ownership preparation."
  fi

  local attempts=0
  while [[ "${attempts}" -lt 50 ]]; do
    exec 8>"${STATE_LOCK}"
    flock -x 8
    if read_state && [[ "${token}" == "${requested_token}" && "${status}" == "activating" \
      && "${guardian_ack_token}" == "${requested_token}" ]]; then
      status="prepared"
      current_now="$(now_epoch)"
      deadline_epoch="$((current_now + lease_seconds))"
      write_state
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
  abandon_unacknowledged_begin "${requested_token}" || true
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
        prepared:quiesced|quiesced:syncing|syncing:synced|synced:boundary) ;;
        *) die "invalid deployment state transition." ;;
      esac
      status="${replacement}"
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    renew)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      [[ -z "${expected}" || "${status}" == "${expected}" ]] \
        || die "expected deployment state ${expected}, found ${status}."
      case "${status}" in prepared|quiesced|syncing|synced|boundary) ;; *) die "deployment lease cannot be renewed in ${status}." ;; esac
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    annotate)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      valid_previous_provenance "${expected}" || die "previous release provenance is invalid."
      valid_path "${replacement}" || die "exact backup path is invalid."
      path_is_equal_or_descendant "${replacement}" "${backup_root}" || die "exact backup is outside the backup root."
      previous_commit="${expected}"
      exact_backup="${replacement}"
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    candidate)
      [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."
      [[ "${status}" == "synced" ]] || die "release candidate can only be recorded after source synchronization."
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

inspect_ownership() {
  local requested_token="$1"
  valid_token "${requested_token}" || die "deployment token is invalid."
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -s 8
  if [[ ! -e "${ACTIVE_STATE}" ]]; then
    printf 'OWNERSHIP=none\n'
    flock -u 8
    return 0
  fi
  read_state || die "active deployment state is malformed."
  if [[ "${token}" == "${requested_token}" ]]; then
    printf 'OWNERSHIP=exact\n'
  else
    printf 'OWNERSHIP=other\n'
  fi
  flock -u 8
}

run_guarded_action_command() {
  local action="$1"
  validate_bundle_trust
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" \
    && "${ATLAS_COORDINATOR_TEST_ACTION:-}" == "${action}" \
    && -n "${ATLAS_COORDINATOR_TEST_MUTATION_FILE:-}" ]]; then
    /bin/bash -c '
target="$1"
(
  trap "" TERM
  while true; do
    printf x >> "${target}"
    /bin/sleep 0.02
  done
) &
if [[ "${ATLAS_COORDINATOR_TEST_ORPHAN:-0}" == "1" ]]; then
  exit 0
fi
wait
' _ "${ATLAS_COORDINATOR_TEST_MUTATION_FILE}"
    return
  fi
  case "${action}" in
    backup)
      local backup_output backup_path backup_file
      backup_path="none"
      if docker volume inspect atlas-db >/dev/null 2>&1; then
        grep -Fxq 'ATLAS_BACKUP_FORMAT="atlas-v2-postgres-artifacts-v1"' "${BACKUP_TOOL_PATH}" \
          || die "existing database backup tool has an unsupported format."
        backup_output="$(BACKUP_ROOT="${backup_root}" COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT}" \
          ATLAS_GIT_COMMIT="${previous_commit}" ATLAS_KEEP_QUIESCED=1 \
          ATLAS_DEPLOYMENT_TOKEN="${token}" ATLAS_REPOSITORY_ROOT="${remote_dir}" \
          ATLAS_BACKUP_ACTION_NAME="backup" ATLAS_BACKUP_ACTION_PHASE="prepared" \
          ATLAS_BACKUP_ACTION_PID="${action_pid}" ATLAS_BACKUP_ACTION_UNIT="${action_unit}" \
          ATLAS_BACKUP_STATE_ROOT="${STATE_ROOT}" ATLAS_BACKUP_GLOBAL_LOCK="${GLOBAL_LOCK}" \
          ATLAS_BACKUP_NOW_EPOCH="$(now_epoch)" \
          ATLAS_INITIAL_PROVENANCE_SHA256="${migration_set_hash}" \
          ATLAS_BACKUP_TEST_MODE="${ATLAS_COORDINATOR_TEST_MODE:-0}" \
          "${BACKUP_TOOL_PATH}")"
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
      ATLAS_DEPLOYMENT_TOKEN="${token}" PGAPPNAME="atlas-deploy-${token}" \
        "${RESTORE_TOOL_PATH}" "${exact_backup}"
      ;;
    sync-release)
      local archive environment candidate
      if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" \
        && "${FAKE_SYNC_RELEASE_FAIL:-0}" == "1" ]]; then
        echo "simulated guarded release promotion failure" >&2
        return 74
      fi
      archive="${candidate_stage}/atlas-release.tar"
      environment="${candidate_stage}/atlas.env"
      candidate="${prior_release_path}"
      [[ -f "${archive}" && ! -L "${archive}" ]] || die "candidate archive is unavailable."
      [[ -f "${environment}" && ! -L "${environment}" ]] || die "candidate environment is unavailable."
      [[ "$(hash_file "${archive}")" == "${release_archive_hash}" ]] || die "candidate archive hash mismatch."
      [[ "$(hash_file "${environment}")" == "${environment_hash}" ]] || die "candidate environment hash mismatch."
      [[ ! -e "${candidate}" ]] || die "candidate stage contains stale promotion output."
      if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
        install -m 0750 -d "${candidate}"
      else
        install -o root -g root -m 0750 -d "${candidate}"
      fi
      tar -xf "${archive}" -C "${candidate}"
      [[ ! -e "${candidate}/.atlas-release" && ! -e "${candidate}/.atlas-candidate" ]] \
        || die "candidate archive contains reserved release metadata."
      printf '%s\n' "${bundle_version}" > "${candidate}/.atlas-candidate"
      chmod 0600 "${candidate}/.atlas-candidate"
      if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
        install -m 0600 "${environment}" "${candidate}/.env"
      else
        install -o root -g root -m 0600 "${environment}" "${candidate}/.env"
      fi
      [[ "$(hash_file "${candidate}/.env")" == "${environment_hash}" ]] \
        || die "installed candidate environment hash mismatch."
      durable_unlink "${environment}"
      atomic_exchange_directories "${candidate}" "${remote_dir}"
      if [[ "${ATLAS_COORDINATOR_SYNC_FAULT:-}" == "after-exchange" ]]; then
        return 88
      fi
      ;;
    build-db)
      docker compose config >/dev/null
      docker compose build web worker
      docker compose run --rm --no-deps --label "atlas.deployment-token=${token}" web node --input-type=module -e \
        "import('./dist/server/config.js')"
      docker compose run --rm --no-deps --label "atlas.deployment-token=${token}" worker node --input-type=module -e \
        "import('./dist/worker/config.js').then(({parseWorkerConfig}) => parseWorkerConfig(process.env))"
      docker compose run --rm --no-deps --label "atlas.deployment-token=${token}" migrator node --input-type=module -e \
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
      docker compose exec -T -e "PGAPPNAME=atlas-deploy-${token}" db bash -s -- \
        < "${ROLE_INITIALIZER_PATH}"
      ;;
    migrate)
      docker compose --profile operations run --rm --label "atlas.deployment-token=${token}" \
        -e "PGAPPNAME=atlas-deploy-${token}" migrator
      ;;
    start-writers)
      docker compose up -d web worker
      docker compose up -d --force-recreate caddy
      docker compose up -d --wait --wait-timeout 180
      docker compose ps
      ;;
    verify-contract)
      docker compose exec -T -e "PGAPPNAME=atlas-deploy-${token}" db \
        psql --username=atlas --dbname=atlas \
        --variable=ON_ERROR_STOP=1 --tuples-only --no-align <<'SQL'
DO $ownership_contract$
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
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname = 'atlas_reject_audit_mutation'
       AND r.rolname = 'atlas_migrator'
  ) THEN
    RAISE EXCEPTION 'Atlas migration ownership contract failed';
  END IF;
END
$ownership_contract$;
SQL
      docker compose --profile operations run --rm --label "atlas.deployment-token=${token}" \
        -e "PGAPPNAME=atlas-deploy-${token}" migrator \
        node dist/server/platform/db/verify-runtime-permissions.js
      ;;
    verify-release)
      local target_health public_health worker_container worker_health
      valid_commit "${release_commit}" && [[ "${release_commit}" != "none" ]] \
        || die "exact release verification requires a recorded candidate commit."
      target_health="$(curl --fail --silent --show-error \
        --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
        --noproxy '*' \
        --resolve atlas.rangeway.app:443:127.0.0.1 \
        https://atlas.rangeway.app/api/v2/ready)"
      HEALTH_JSON="${target_health}" python3 -c '
import json
import os
import sys
health = json.loads(os.environ.get("HEALTH_JSON", "null"))
expected = sys.argv[1]
if health.get("apiVersion") != "v2" or health.get("contractVersion") != "atlas-v2-foundation-v1" or health.get("release") != expected:
    raise SystemExit("target readiness did not match the exact Atlas V2 release")
' "${release_commit}"
      worker_container="$(docker compose ps -q worker)"
      [[ -n "${worker_container}" ]] || die "worker container is unavailable for exact release verification."
      worker_health="$(docker inspect --format '{{.State.Health.Status}}' "${worker_container}")"
      [[ "${worker_health}" == "healthy" ]] || die "worker readiness is not healthy."
      public_health="$(curl --fail --silent --show-error \
        --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 \
        https://atlas.rangeway.app/api/v2/ready)"
      HEALTH_JSON="${public_health}" python3 -c '
import json
import os
import sys
health = json.loads(os.environ.get("HEALTH_JSON", "null"))
expected = sys.argv[1]
if health.get("apiVersion") != "v2" or health.get("contractVersion") != "atlas-v2-foundation-v1" or health.get("release") != expected:
    raise SystemExit("public readiness did not match the exact Atlas V2 release")
' "${release_commit}"
      printf 'VERIFIED_RELEASE=%s\n' "${release_commit}"
      ;;
    *) die "guarded deployment action is invalid." ;;
  esac
}

action_group_has_live_members() {
  local target_group="$1"
  local process_snapshot member_pid member_group member_state
  process_snapshot="$(ps -axo pid=,pgid=,state=)"
  while read -r member_pid member_group member_state; do
    [[ "${member_group}" == "${target_group}" ]] || continue
    [[ "${member_state}" != Z* ]] || continue
    return 0
  done <<< "${process_snapshot}"
  return 1
}

terminate_action_group() {
  local group_pid="$1"
  local expected_token="$2"
  local attempts=0 command_line process_group max_attempts=50
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
    max_attempts=5
  fi
  [[ "${group_pid}" =~ ^[1-9][0-9]*$ ]] \
    || { echo "Atlas action cleanup rejected an invalid process-group identity." >&2; return 1; }
  if action_group_has_live_members "${group_pid}"; then
    command_line="$(ps -o command= -p "${group_pid}" 2>/dev/null || true)"
    process_group="$(ps -o pgid= -p "${group_pid}" 2>/dev/null | tr -d '[:space:]')"
    [[ "${process_group}" == "${group_pid}" ]] \
      || { echo "Atlas action cleanup could not authenticate the recorded process-group leader." >&2; return 1; }
    [[ "${command_line}" == *"action-reaper"* && "${command_line}" == *"${expected_token}"* ]] \
      || { echo "Atlas action cleanup rejected the recorded process-group command." >&2; return 1; }
    if ! kill -TERM -- "-${group_pid}" 2>/dev/null; then
      if action_group_has_live_members "${group_pid}"; then
        return 1
      fi
    fi
    while action_group_has_live_members "${group_pid}" && [[ "${attempts}" -lt "${max_attempts}" ]]; do
      /bin/sleep 0.1
      attempts=$((attempts + 1))
    done
    if action_group_has_live_members "${group_pid}"; then
      if ! kill -KILL -- "-${group_pid}" 2>/dev/null; then
        if action_group_has_live_members "${group_pid}"; then
          return 1
        fi
      fi
      attempts=0
      while action_group_has_live_members "${group_pid}" && [[ "${attempts}" -lt "${max_attempts}" ]]; do
        /bin/sleep 0.1
        attempts=$((attempts + 1))
      done
    fi
  fi
  ! action_group_has_live_members "${group_pid}"
}

valid_action_unit() {
  local candidate="$1"
  local expected_token="$2"
  local expected_action="$3"
  [[ "${candidate}" == "atlas-v2-deploy-${expected_token}-${expected_action}.service" ]]
}

terminate_action_unit() {
  local unit="$1"
  local expected_token="$2"
  local expected_action="$3"
  local control_group active_state process_file
  valid_action_unit "${unit}" "${expected_token}" "${expected_action}" || return 1
  control_group="$(systemctl show --property=ControlGroup --value "${unit}" 2>/dev/null || true)"
  [[ -z "${control_group}" || "${control_group}" == "/system.slice/${unit}" ]] || return 1
  systemctl stop "${unit}" >/dev/null || return 1
  if systemctl is-active --quiet "${unit}"; then
    systemctl kill --kill-whom=all --signal=KILL "${unit}" >/dev/null || return 1
  fi
  active_state="$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null || true)"
  case "${active_state}" in inactive|failed|"") ;; *) return 1 ;; esac
  if [[ -n "${control_group}" && -d "/sys/fs/cgroup${control_group}" ]]; then
    while IFS= read -r process_file; do
      [[ ! -s "${process_file}" ]] || return 1
    done < <(find "/sys/fs/cgroup${control_group}" -name cgroup.procs -type f -print)
  fi
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
}

terminate_recorded_action() {
  local expected_token="$1"
  local expected_action="$2"
  local recorded_pid="$3"
  local recorded_unit="$4"
  if [[ "${recorded_unit}" != "none" ]]; then
    terminate_action_unit "${recorded_unit}" "${expected_token}" "${expected_action}"
  else
    terminate_action_group "${recorded_pid}" "${expected_token}"
  fi
}

cancel_token_actions() {
  local requested_token="$1"
  local snapshot line container project_label service_label extra remaining sessions db_container
  local -a containers=()
  snapshot="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=atlas.deployment-token=${requested_token}" \
    --format '{{.ID}}')"
  while IFS= read -r container extra; do
    [[ -n "${container}" ]] || continue
    [[ "${container}" =~ ^[A-Za-z0-9_.-]+$ && -z "${extra:-}" ]] || return 1
    containers+=("${container}")
  done <<< "${snapshot}"
  if [[ "${#containers[@]}" -gt 0 ]]; then
    docker rm -f -- "${containers[@]}" >/dev/null
  fi

  # A pre-token migrator is never part of the restorable writer set. Fence any
  # exact Atlas migrator before proving this deployment has no database session.
  snapshot="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=migrator" \
    --format '{{.ID}}')"
  containers=()
  while IFS= read -r container extra; do
    [[ -n "${container}" ]] || continue
    [[ "${container}" =~ ^[A-Za-z0-9_.-]+$ && -z "${extra:-}" ]] || return 1
    containers+=("${container}")
  done <<< "${snapshot}"
  if [[ "${#containers[@]}" -gt 0 ]]; then
    docker stop -- "${containers[@]}" >/dev/null
  fi
  remaining="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=migrator" \
    --format '{{.ID}}')"
  [[ -z "${remaining}" ]] || return 1

  snapshot="$(docker ps -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=db" \
    --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}')"
  db_container="none"
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    IFS='|' read -r container project_label service_label extra <<< "${line}"
    [[ "${container}" =~ ^[A-Za-z0-9_.-]+$ \
      && "${project_label}" == "${COMPOSE_PROJECT}" && "${service_label}" == "db" \
      && -z "${extra:-}" && "${line}" == *"|"*"|"* ]] || return 1
    [[ "${db_container}" == "none" ]] || return 1
    db_container="${container}"
  done <<< "${snapshot}"
  [[ "${db_container}" != "none" ]] || return 0

  if ! sessions="$(docker exec "${db_container}" psql --username=atlas --dbname=atlas \
    --variable=ON_ERROR_STOP=1 --tuples-only --no-align \
    --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND application_name = 'atlas-deploy-${requested_token}'; SELECT count(*) FROM pg_stat_activity WHERE application_name = 'atlas-deploy-${requested_token}';" \
    2>/dev/null | tail -n 1)"; then
    return 1
  fi
  [[ "${sessions}" == "0" ]] || return 1
}

guarded_action_child() {
  local requested_token="$1"
  local expected_status="$2"
  local action="$3"
  local gate="$4"
  local recorded_reaper="$5"
  local attempts=0
  while [[ ! -f "${gate}" && "${attempts}" -lt 100 ]]; do
    /bin/sleep 0.01
    attempts=$((attempts + 1))
  done
  [[ -f "${gate}" ]] || die "guarded action gate was not published."
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -s 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" && "${status}" == "${expected_status}" ]] \
    || die "guarded action ownership changed before execution."
  [[ "${action_name}" == "${action}" && "${action_phase}" == "${expected_status}" ]] \
    || die "guarded action identity does not match durable state."
  if [[ "${action_unit}" == "none" ]]; then
    [[ "${action_pid}" == "${recorded_reaper}" ]] \
      || die "guarded action reaper identity does not match durable state."
  else
    valid_action_unit "${action_unit}" "${requested_token}" "${action}" \
      || die "guarded action systemd unit does not match durable state."
  fi
  flock -u 8
  cd -- "${remote_dir}"
  if [[ "${release_commit}" != "none" ]]; then
    export ATLAS_IMAGE_TAG="${release_commit}"
    export ATLAS_RELEASE_SHA="${release_commit}"
  fi
  run_guarded_action_command "${action}"
}

guarded_action_reaper() {
  local requested_token="$1"
  local expected_status="$2"
  local action="$3"
  local gate="$4"
  local primary_pid primary_status member_pid member_group descendants process_snapshot
  trap '' TERM
  "$0" action-child "${requested_token}" "${expected_status}" "${action}" "${gate}" "$$" &
  primary_pid="$!"
  set +e
  wait "${primary_pid}"
  primary_status="$?"
  set -e
  while true; do
    descendants=0
    process_snapshot="$(ps -axo pid=,pgid=)"
    while read -r member_pid member_group; do
      [[ "${member_group}" == "$$" && "${member_pid}" != "$$" ]] || continue
      kill -0 "${member_pid}" 2>/dev/null || continue
      descendants=1
      break
    done <<< "${process_snapshot}"
    [[ "${descendants}" -eq 1 ]] || break
    /bin/sleep 0.05
  done
  return "${primary_status}"
}

guard_deployment_action() {
  local requested_token="$1"
  local expected_status="$2"
  local action="$3"
  local required_status current_now child_pid action_status heartbeat_interval gate cancelled
  local recorded_unit action_output cleanup_proven
  case "${action}" in
    backup|restore-backup) required_status="prepared" ;;
    sync-release) required_status="syncing" ;;
    build-db) required_status="synced" ;;
    rotate-roles|migrate|start-writers|verify-contract|verify-release) required_status="boundary" ;;
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
  [[ "${action_name}" == "none" ]] || die "another guarded action is already recorded."
  deadline_epoch="$((current_now + lease_seconds))"
  gate="${STATE_ROOT}/.${requested_token}.${action}.gate"
  action_output="${STATE_ROOT}/.${requested_token}.${action}.output"
  rm -f -- "${gate}"
  rm -f -- "${action_output}"
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
    action_unit="none"
    python3 -c '
import os
import sys
os.setsid()
os.execv("/bin/bash", ["bash", *sys.argv[1:]])
' "$0" action-reaper "${requested_token}" "${expected_status}" "${action}" "${gate}" &
  else
    action_unit="atlas-v2-deploy-${requested_token}-${action}.service"
    systemd-run --quiet --wait --pipe \
      --unit="${action_unit}" \
      --service-type=exec \
      --property=ExitType=cgroup \
      --property=KillMode=control-group \
      --property=TimeoutStopSec=5s \
      "${COORDINATOR_PATH}" action-child \
      "${requested_token}" "${expected_status}" "${action}" "${gate}" systemd \
      > "${action_output}" &
  fi
  child_pid="$!"
  action_name="${action}"
  action_pid="${child_pid}"
  action_phase="${expected_status}"
  recorded_unit="${action_unit}"
  write_state
  printf 'go\n' | durable_publish "${gate}" 0600
  flock -u 8

  # One-second heartbeats keep the kill/wait path bounded even for the maximum
  # 15-minute lease and leave ample margin for the minimum two-second lease.
  if [[ "${ATLAS_COORDINATOR_TEST_MODE:-0}" == "1" ]]; then
    heartbeat_interval=0.05
  else
    heartbeat_interval=1
  fi
  cancelled=0
  while {
    if [[ "${recorded_unit}" == "none" ]]; then
      action_group_has_live_members "${child_pid}"
    else
      systemctl is-active --quiet "${recorded_unit}" || kill -0 "${child_pid}" 2>/dev/null
    fi
  }; do
    /bin/sleep "${heartbeat_interval}"
    exec 7>"${STATE_LOCK}"
    flock -x 7
    if ! read_state \
      || [[ "${token}" != "${requested_token}" ]] \
      || [[ "${status}" != "${expected_status}" ]] \
      || [[ "${action_name}" != "${action}" ]] \
      || [[ "${action_pid}" != "${child_pid}" ]] \
      || [[ "${action_unit}" != "${recorded_unit}" ]]; then
      flock -u 7
      cancelled=1
      break
    fi
    current_now="$(now_epoch)"
    if [[ "${deadline_epoch}" -le "${current_now}" ]]; then
      flock -u 7
      cancelled=1
      break
    fi
    deadline_epoch="$((current_now + lease_seconds))"
    write_state
    flock -u 7
  done
  cleanup_proven=1
  if [[ "${cancelled}" -eq 1 ]]; then
    mkdir -p -- "$(dirname -- "${ACTION_CLEANUP_LOCK}")"
    exec 6>"${ACTION_CLEANUP_LOCK}"
    flock -x 6
    terminate_recorded_action "${requested_token}" "${action}" "${child_pid}" "${recorded_unit}" \
      || cleanup_proven=0
  fi
  if [[ "${cleanup_proven}" -eq 0 ]] && kill -0 "${child_pid}" 2>/dev/null; then
    action_status=1
  else
    set +e
    wait "${child_pid}"
    action_status="$?"
    set -e
  fi
  if [[ "${recorded_unit}" == "none" ]] && action_group_has_live_members "${child_pid}"; then
    terminate_action_group "${child_pid}" "${requested_token}" || cleanup_proven=0
  elif [[ "${recorded_unit}" != "none" ]] && systemctl is-active --quiet "${recorded_unit}"; then
    terminate_action_unit "${recorded_unit}" "${requested_token}" "${action}" || cleanup_proven=0
  fi
  if [[ "${cancelled}" -eq 1 || "${action_status}" -ne 0 ]]; then
    cancel_token_actions "${requested_token}" || cleanup_proven=0
  fi
  if [[ "${cancelled}" -eq 1 ]]; then
    flock -u 6
  fi
  if [[ -s "${action_output}" ]]; then
    cat -- "${action_output}"
  fi
  rm -f -- "${gate}"
  rm -f -- "${action_output}"
  exec 8>"${STATE_LOCK}"
  flock -x 8
  if read_state \
    && [[ "${token}" == "${requested_token}" ]] \
    && [[ "${action_name}" == "${action}" ]] \
    && [[ "${action_pid}" == "${child_pid}" ]] \
    && [[ "${action_unit}" == "${recorded_unit}" ]] \
    && [[ "${cleanup_proven}" -eq 1 ]]; then
    action_name="none"
    action_pid="none"
    action_phase="none"
    action_unit="none"
    write_state
  fi
  flock -u 8
  [[ "${cleanup_proven}" -eq 1 ]] || return 1
  [[ "${cancelled}" -eq 0 ]] || return 1
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

  if ! validate_bundle_trust; then
    local trust_cleanup_failed=0
    if [[ "${action_name}" != "none" ]]; then
      mkdir -p -- "$(dirname -- "${ACTION_CLEANUP_LOCK}")"
      exec 6>"${ACTION_CLEANUP_LOCK}"
      flock -x 6
      terminate_recorded_action "${token}" "${action_name}" "${action_pid}" "${action_unit}" \
        || trust_cleanup_failed=1
      cancel_token_actions "${token}" || trust_cleanup_failed=1
      flock -u 6
    fi
    stop_all_writers "${remote_dir}" || true
    status="failed_closed"
    deadline_epoch=0
    if [[ "${trust_cleanup_failed}" -eq 0 ]]; then
      action_name="none"
      action_pid="none"
      action_phase="none"
      action_unit="none"
    fi
    write_state
    flock -u 8
    echo "Atlas deployment coordinator failed closed because immutable bundle trust failed." >&2
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

  if [[ "${action_name}" != "none" ]]; then
    local expired_action_pid="${action_pid}"
    local expired_action_name="${action_name}"
    local expired_action_unit="${action_unit}"
    local cleanup_failed=0
    mkdir -p -- "$(dirname -- "${ACTION_CLEANUP_LOCK}")"
    exec 6>"${ACTION_CLEANUP_LOCK}"
    flock -x 6
    terminate_recorded_action "${token}" "${expired_action_name}" \
      "${expired_action_pid}" "${expired_action_unit}" || {
        echo "Atlas exact action execution could not be terminated." >&2
        cleanup_failed=1
      }
    cancel_token_actions "${token}" || {
      echo "Atlas exact-token containers or database sessions could not be cleared." >&2
      cleanup_failed=1
    }
    flock -u 6
    if [[ "${cleanup_failed}" -ne 0 ]]; then
      case "${status}" in
        boundary|failed_closed) status="failed_closed" ;;
        *) status="recovery_failed" ;;
      esac
      deadline_epoch=0
      write_state
      flock -u 8
      echo "Atlas deployment coordinator could not prove exact action cleanup." >&2
      return 1
    fi
    action_name="none"
    action_pid="none"
    action_phase="none"
    action_unit="none"
    write_state
  fi

  case "${status}" in
    activating|prepared|quiesced|syncing|synced|recovery_failed)
      if restore_prior_release_tree && restore_exact_writers; then
        status="recovered"
        deadline_epoch=0
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

retire_recovered_deployment() {
  local recovered_candidate_archive
  acquire_install_lock
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "recovered deployment state is missing or malformed."
  [[ "${status}" == "recovered" ]] || die "only a recovered deployment can be retired automatically."
  [[ "${guardian_ack_token}" == "${token}" ]] || die "recovered deployment guardian token is unauthenticated."
  [[ "${deadline_epoch}" == "0" ]] || die "recovered deployment lease was not durably retired."
  [[ "${action_name}" == "none" && "${action_pid}" == "none" && "${action_unit}" == "none" ]] \
    || die "recovered deployment still records an active action."
  validate_bundle_trust || die "recovered deployment bundle validation failed."
  release_marker_matches_previous "${remote_dir}" \
    || die "recovered deployment did not restore the exact prior release marker."

  systemctl disable --now "${UNIT_NAME}" >/dev/null
  if systemctl is-active --quiet "${UNIT_NAME}"; then
    die "recovered deployment guardian could not be stopped."
  fi

  if [[ -e "${prior_release_path}" ]]; then
    [[ -d "${prior_release_path}" && ! -L "${prior_release_path}" ]] \
      || die "recovered candidate tree is invalid."
    tree_is_candidate "${prior_release_path}" || die "recovered candidate tree identity is invalid."
    recovered_candidate_archive="${HISTORY_ROOT}/${token}.recovered-candidate"
    [[ ! -e "${recovered_candidate_archive}" ]] || die "recovered candidate archive already exists."
    durable_move "${prior_release_path}" "${recovered_candidate_archive}"
  fi
  cleanup_candidate_stage || die "recovered deployment stage could not be retired safely."
  durable_move "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.recovered.state"
  flock -u 8
}

complete_deployment() {
  local requested_token="$1"
  local requested_commit="$2"
  local current_now
  valid_commit "${requested_commit}" || die "release commit is invalid."
  [[ "${requested_commit}" != "none" ]] || die "release commit is required."
  acquire_install_lock
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" ]] || die "deployment ownership token does not match."
  [[ "${status}" == "boundary" ]] || die "only a boundary deployment can be completed."
  [[ "${release_commit}" == "${requested_commit}" ]] || die "release commit does not match the guarded candidate."
  [[ "${action_name}" == "none" ]] || die "a guarded deployment action is still active."
  validate_bundle_trust || die "immutable deployment bundle validation failed."
  current_now="$(now_epoch)"
  [[ "${deadline_epoch}" -gt "${current_now}" ]] || die "deployment ownership lease expired."

  umask 077
  tree_is_candidate "${remote_dir}" || die "live release does not match the guarded candidate tree."
  release_marker_matches_previous "${prior_release_path}" \
    || die "retained previous release tree or marker is invalid."
  archive_prior_release_tree || die "previous release tree could not be archived safely."
  cleanup_candidate_stage || die "completed deployment stage could not be retired safely."
  durable_unlink "${remote_dir}/.atlas-candidate"
  printf '%s\n' "${requested_commit}" | durable_publish "${remote_dir}/.atlas-release" 0600

  release_commit="${requested_commit}"
  status="complete"
  deadline_epoch=0
  write_state
  flock -u 8
  systemctl disable --now "${UNIT_NAME}" >/dev/null
  if systemctl is-active --quiet "${UNIT_NAME}"; then
    die "completed deployment guardian could not be stopped."
  fi

  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "completed deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" && "${status}" == "complete" \
    && "${action_name}" == "none" ]] \
    || die "completed deployment ownership changed before archival."
  durable_move "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.complete.state"
  flock -u 8
}

usage() {
  echo "usage: $0 begin|transition|renew|assert|ownership|annotate|candidate|guard|fail|complete|guardian|guardian-once|retire-recovered ..." >&2
  exit 64
}

command="${1:-}"
case "${command}" in
  begin) [[ "$#" -eq 16 ]] || usage; begin_deployment "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "${13}" "${14}" "${15}" "${16}" ;;
  transition) [[ "$#" -eq 4 ]] || usage; mutate_state "$2" transition "$3" "$4" ;;
  renew) [[ "$#" -eq 3 ]] || usage; mutate_state "$2" renew "$3" ;;
  assert) [[ "$#" -eq 3 ]] || usage; assert_deployment "$2" "$3" ;;
  ownership) [[ "$#" -eq 2 ]] || usage; inspect_ownership "$2" ;;
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
  retire-recovered) [[ "$#" -eq 1 ]] || usage; retire_recovered_deployment ;;
  action-child) [[ "$#" -eq 6 ]] || usage; guarded_action_child "$2" "$3" "$4" "$5" "$6" ;;
  action-reaper) [[ "$#" -eq 5 ]] || usage; guarded_action_reaper "$2" "$3" "$4" "$5" ;;
  *) usage ;;
esac
