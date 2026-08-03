#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root on the Ubuntu VPS." >&2
  exit 1
fi

[[ -r /etc/os-release ]] || {
  echo "Atlas V2 requires readable /etc/os-release metadata." >&2
  exit 1
}
os_id="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')"
os_version="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')"
if [[ "${os_id}" != "ubuntu" || "${os_version}" != "24.04" ]]; then
  echo "Atlas V2 requires Ubuntu 24.04 LTS." >&2
  exit 1
fi
systemd_version="$(systemctl --version | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p')"
if [[ ! "${systemd_version}" =~ ^[0-9]+$ || "${systemd_version}" -lt 255 ]]; then
  echo "Atlas V2 requires systemd 255 or newer." >&2
  exit 1
fi
probe_unit="atlas-v2-exittype-probe-$$.service"
cleanup_probe() {
  systemctl stop "${probe_unit}" >/dev/null 2>&1 || true
  systemctl reset-failed "${probe_unit}" >/dev/null 2>&1 || true
}
trap cleanup_probe EXIT INT TERM
systemd-run --quiet --wait --collect --unit="${probe_unit}" --service-type=exec \
  --property=ExitType=cgroup --property=KillMode=control-group /bin/true || {
  echo "Atlas V2 requires transient ExitType=cgroup support." >&2
  exit 1
}
cleanup_probe
if [[ "$(systemctl show --property=LoadState --value "${probe_unit}")" != "not-found" ]]; then
  echo "Atlas V2 host capability probe left a transient unit loaded." >&2
  exit 1
fi
trap - EXIT INT TERM

apt-get update
apt-get install -y ca-certificates curl git gnupg python3 rsync ufw util-linux

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi

. /etc/os-release
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

install -o root -g root -m 0755 -d /run/lock
exec 9>/run/lock/atlas-v2-deployment-install.lock
flock -x 9

if systemctl is-active --quiet atlas-v2-deployment-guardian.service \
  || [[ -e /var/lib/atlas-v2-deployment/active.state ]]; then
  echo "Resolve the active Atlas deployment before replacing coordinator files." >&2
  exit 1
fi

install -o root -g root -m 0750 -d /opt/atlas-v2
install -o root -g root -m 0700 -d /var/backups/atlas-v2
install -o root -g root -m 0700 -d /var/lib/atlas-v2-deployment
install -o root -g root -m 0700 -d /var/lib/atlas-v2-deployment/staging
install -o root -g root -m 0755 -d /usr/local/libexec/atlas-v2
install -m 0755 deploy/deployment-coordinator.sh /usr/local/sbin/atlas-v2-deployment-coordinator
install -m 0644 deploy/systemd/atlas-v2-deployment-guardian.service \
  /etc/systemd/system/atlas-v2-deployment-guardian.service
install -m 0755 deploy/backup.sh /usr/local/libexec/atlas-v2/backup.sh
install -m 0755 deploy/restore-test.sh /usr/local/libexec/atlas-v2/restore-test.sh
install -m 0755 deploy/postgres/init-roles.sh /usr/local/libexec/atlas-v2/init-roles.sh
install -m 0644 deploy/Caddyfile /usr/local/libexec/atlas-v2/Caddyfile
systemctl daemon-reload

echo "Ubuntu is ready for Atlas V2 deployment by a root SSH administrator at /opt/atlas-v2."
