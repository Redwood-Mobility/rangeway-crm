#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root on the Ubuntu VPS." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg python3 sudo ufw

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

if ! getent passwd atlas >/dev/null; then
  useradd --create-home --shell /bin/bash atlas
fi
usermod --append --groups docker atlas

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

if systemctl is-active --quiet atlas-v2-deployment-guardian.service \
  || [[ -e /var/lib/atlas-v2-deployment/active.state ]]; then
  echo "Resolve the active Atlas deployment before replacing coordinator files." >&2
  exit 1
fi

install -o atlas -g atlas -m 0755 -d /opt/atlas-v2
install -o atlas -g atlas -m 0700 -d /opt/atlas-v2/.atlas-coordinator-staging
install -o atlas -g atlas -m 0700 -d /var/backups/atlas-v2
install -o root -g root -m 0700 -d /var/lib/atlas-v2-deployment
install -m 0755 deploy/deployment-coordinator.sh /usr/local/sbin/atlas-v2-deployment-coordinator
install -m 0644 deploy/systemd/atlas-v2-deployment-guardian.service \
  /etc/systemd/system/atlas-v2-deployment-guardian.service

cat > /etc/sudoers.d/atlas-v2-deploy <<'SUDOERS'
Cmnd_Alias ATLAS_COORDINATOR = /usr/local/sbin/atlas-v2-deployment-coordinator *
Cmnd_Alias ATLAS_COORDINATOR_INSTALL = \
  /usr/bin/install -o root -g root -m 0755 /opt/atlas-v2/.atlas-coordinator-staging/deployment-coordinator.sh /usr/local/sbin/atlas-v2-deployment-coordinator.next, \
  /usr/bin/install -o root -g root -m 0644 /opt/atlas-v2/.atlas-coordinator-staging/atlas-v2-deployment-guardian.service /etc/systemd/system/atlas-v2-deployment-guardian.service.next, \
  /usr/bin/mv -f -- /usr/local/sbin/atlas-v2-deployment-coordinator.next /usr/local/sbin/atlas-v2-deployment-coordinator, \
  /usr/bin/mv -f -- /etc/systemd/system/atlas-v2-deployment-guardian.service.next /etc/systemd/system/atlas-v2-deployment-guardian.service
Cmnd_Alias ATLAS_SYSTEMD_VERIFY = \
  /usr/bin/systemctl daemon-reload, \
  /usr/bin/systemctl cat --no-pager --full atlas-v2-deployment-guardian.service, \
  /usr/bin/systemctl is-active --quiet atlas-v2-deployment-guardian.service, \
  /usr/bin/stat -c %F /var/lib/atlas-v2-deployment/active.state
atlas ALL=(root) NOPASSWD: ATLAS_COORDINATOR, ATLAS_COORDINATOR_INSTALL, ATLAS_SYSTEMD_VERIFY
SUDOERS
chmod 0440 /etc/sudoers.d/atlas-v2-deploy
visudo -cf /etc/sudoers.d/atlas-v2-deploy >/dev/null
systemctl daemon-reload

echo "Ubuntu is ready for Atlas V2 deployment by the atlas operator at /opt/atlas-v2."
