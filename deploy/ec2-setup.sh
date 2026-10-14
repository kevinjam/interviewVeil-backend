#!/usr/bin/env bash
# One-time setup for a fresh Amazon Linux 2023 EC2 instance (t2.micro / t3.micro).
# Run as ec2-user:  bash deploy/ec2-setup.sh
set -euo pipefail

# Docker + Compose plugin
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 2 GB swap: free-tier instances have 1 GB RAM, which isn't enough to build the image.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo "/swapfile swap swap defaults 0 0" | sudo tee -a /etc/fstab
fi

echo "Done. Log out and back in (for the docker group), then see deploy/README.md."
