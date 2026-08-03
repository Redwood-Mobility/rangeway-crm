#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root on the Ubuntu VPS." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg python3 rsync ufw

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
systemctl daemon-reload

echo "Ubuntu is ready for Atlas V2 deployment by a root SSH administrator at /opt/atlas-v2."
