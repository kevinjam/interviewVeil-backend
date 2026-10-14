#!/usr/bin/env bash
# One-time Ubuntu 24.04 (or similar) setup for native production deploy.
# Run on the server with sudo available. Does not use Docker.
#
#   INSTALL_LOCAL_POSTGRES=1 sudo -E bash deploy/native/ubuntu-bootstrap.sh
#
# After this script: create backend/.env, enable the Nginx site, run certbot, then release-deploy.sh.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "Run as your deploy user (e.g. deploy), not root. The script will call sudo where needed."
  exit 1
fi

echo "==> Base packages"
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl ufw fail2ban nginx

echo "==> Firewall"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"
sudo ufw --force enable

if ! swapon --show | grep -q /swapfile; then
  echo "==> 2G swap"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "==> Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node -v
sudo npm install -g pm2
pm2 install pm2-logrotate || true

if [[ "${INSTALL_LOCAL_POSTGRES:-0}" == "1" ]]; then
  echo "==> PostgreSQL (local)"
  sudo apt install -y postgresql postgresql-contrib
  echo "Create DB/user manually, e.g.:"
  echo "  sudo -u postgres createuser -P interviewveil"
  echo "  sudo -u postgres createdb -O interviewveil interviewveil"
fi

echo "==> Certbot (run after Nginx site is enabled)"
sudo apt install -y certbot python3-certbot-nginx

echo "Done. Next:"
echo "  1. Clone the repo (e.g. /var/www/interviewveil)"
echo "  2. cp backend/.env.example backend/.env && chmod 600 backend/.env"
echo "  3. API_DOMAIN=api.example.com bash backend/deploy/native/install-nginx-site.sh"
echo "  4. sudo certbot --nginx -d api.example.com"
echo "  5. cd backend && bash deploy/native/release-deploy.sh"
echo "  6. pm2 startup systemd -u $USER --hp $HOME && pm2 save"
