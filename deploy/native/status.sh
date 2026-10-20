#!/usr/bin/env bash
# PM2 + health for interviewveil-api (process runs as deploy, not ubuntu).
# On the server: bash deploy/native/status.sh
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${DEPLOY_PATH:-/var/www/interviewveil}"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-8787}"

echo "==> PM2 (user: $DEPLOY_USER)"
sudo -u "$DEPLOY_USER" -H pm2 list
echo ""
sudo -u "$DEPLOY_USER" -H pm2 describe interviewveil-api 2>/dev/null || echo "(interviewveil-api not in PM2 for $DEPLOY_USER)"
echo ""
API_DOMAIN="${API_DOMAIN:-api.interviewveil.com}"

echo "==> health http://127.0.0.1:${PORT}/health"
if curl -fsS "http://127.0.0.1:${PORT}/health"; then
  echo ""
else
  echo "Health check failed."
  echo "--- last logs ---"
  sudo -u "$DEPLOY_USER" -H pm2 logs interviewveil-api --lines 40 --nostream 2>/dev/null || true
  exit 1
fi

echo "==> public https://${API_DOMAIN}/health (via Nginx)"
if curl -fsS --connect-timeout 8 "https://${API_DOMAIN}/health" 2>/dev/null; then
  echo ""
else
  echo "Public URL failed (Nginx, certbot, DNS, or security group). Run: bash deploy/native/diagnose-public.sh"
fi
