#!/usr/bin/env bash
set -euo pipefail

# Host-wide, boot-reconciled deployment ownership for Atlas V2. The durable
# state file is deliberately parsed as data; it is never sourced as shell code.
UNIT_NAME="atlas-v2-deployment-guardian.service"
STATE_ROOT="/var/lib/atlas-v2-deployment"
CONFIG_FILE="/etc/atlas-v2-deployment-guardian.conf"
GLOBAL_LOCK="/run/lock/atlas-v2-deployment.lock"

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
  local temporary="${destination}.tmp.$$"
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
  } > "${temporary}"
  chmod 0600 "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

write_config() {
  local temporary="${CONFIG_FILE}.tmp.$$"
  umask 077
  mkdir -p -- "$(dirname -- "${CONFIG_FILE}")"
  printf 'REMOTE_DIR=%s\n' "${remote_dir}" > "${temporary}"
  chmod 0600 "${temporary}"
  mv -f -- "${temporary}" "${CONFIG_FILE}"
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
  valid_path "${target}" || return 1
  (cd -- "${target}" && docker compose stop web worker)
}

restore_exact_writers() {
  local failed=0
  if [[ "${worker_container}" != "none" ]]; then
    docker start "${worker_container}" >/dev/null || failed=1
  fi
  if [[ "${web_container}" != "none" ]]; then
    docker start "${web_container}" >/dev/null || failed=1
  fi
  return "${failed}"
}

snapshot_writers() {
  local snapshot line service state container
  web_container="none"
  worker_container="none"
  snapshot="$(cd -- "${remote_dir}" && docker compose ps --all --format '{{.Service}}|{{.State}}|{{.ID}}')"
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    IFS='|' read -r service state container <<< "${line}"
    [[ -n "${service}" && -n "${state}" && -n "${container}" && "${line}" != *"|"*"|"*"|"* ]] \
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
  mv -- "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.${suffix}.state"
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
      [[ "${status}" == "${expected}" ]] || die "expected deployment state ${expected}, found ${status}."
      case "${expected}:${replacement}" in
        prepared:quiesced|quiesced:boundary) ;;
        *) die "invalid deployment state transition." ;;
      esac
      status="${replacement}"
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    renew)
      case "${status}" in prepared|quiesced|boundary) ;; *) die "deployment lease cannot be renewed in ${status}." ;; esac
      deadline_epoch="$((current_now + lease_seconds))"
      ;;
    annotate)
      valid_commit "${expected}" || die "previous release commit is invalid."
      valid_path "${replacement}" || die "exact backup path is invalid."
      path_is_equal_or_descendant "${replacement}" "${backup_root}" || die "exact backup is outside the backup root."
      previous_commit="${expected}"
      exact_backup="${replacement}"
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
  local release_temporary
  valid_commit "${requested_commit}" || die "release commit is invalid."
  [[ "${requested_commit}" != "none" ]] || die "release commit is required."
  prepare_state_root
  exec 8>"${STATE_LOCK}"
  flock -x 8
  read_state || die "active deployment state is missing or malformed."
  [[ "${token}" == "${requested_token}" ]] || die "deployment ownership token does not match."
  [[ "${status}" == "boundary" ]] || die "only a boundary deployment can be completed."

  release_temporary="${remote_dir}/.atlas-release.next"
  umask 077
  printf '%s\n' "${requested_commit}" > "${release_temporary}"
  chmod 0600 "${release_temporary}"
  mv -f -- "${release_temporary}" "${remote_dir}/.atlas-release"

  release_commit="${requested_commit}"
  status="complete"
  write_state
  mv -- "${ACTIVE_STATE}" "${HISTORY_ROOT}/${token}.complete.state"
  flock -u 8
  systemctl disable --now "${UNIT_NAME}" >/dev/null
}

usage() {
  echo "usage: $0 begin|transition|renew|annotate|fail|complete|guardian|guardian-once ..." >&2
  exit 64
}

command="${1:-}"
case "${command}" in
  begin) [[ "$#" -eq 5 ]] || usage; begin_deployment "$2" "$3" "$4" "$5" ;;
  transition) [[ "$#" -eq 4 ]] || usage; mutate_state "$2" transition "$3" "$4" ;;
  renew) [[ "$#" -eq 2 ]] || usage; mutate_state "$2" renew ;;
  annotate) [[ "$#" -eq 4 ]] || usage; mutate_state "$2" annotate "$3" "$4" ;;
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
