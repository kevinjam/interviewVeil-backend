#!/usr/bin/env bash
# Install Nginx vhost for the API. Requires API_DOMAIN (e.g. api.interviewveil.app).
set -euo pipefail

API_DOMAIN="${API_DOMAIN:?Set API_DOMAIN, e.g. api.example.com}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/nginx-interviewveil-api.conf.template"
TARGET="/etc/nginx/sites-available/interviewveil-api"

sed "s/API_DOMAIN/${API_DOMAIN}/g" "$TEMPLATE" | sudo tee "$TARGET" >/dev/null
sudo ln -sf "$TARGET" /etc/nginx/sites-enabled/interviewveil-api
sudo nginx -t
sudo systemctl reload nginx

echo "Nginx site enabled for ${API_DOMAIN} (HTTP :80 only until Certbot adds TLS)."
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo "  sudo certbot --nginx -d ${API_DOMAIN}"
