#!/usr/bin/env bash
# Why https://api…/health fails while 127.0.0.1:8787 works. Run on the EC2 instance:
#   bash /var/www/interviewveil/deploy/native/diagnose-public.sh
# Optional: API_DOMAIN=api.interviewveil.com bash deploy/native/diagnose-public.sh
set -euo pipefail

API_DOMAIN="${API_DOMAIN:-api.interviewveil.com}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${DEPLOY_PATH:-/var/www/interviewveil}"
PORT="$(grep -E '^PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-8787}"

echo "========== InterviewVeil public API diagnose ($API_DOMAIN) =========="
echo ""

echo "==> 1) Node app (localhost)"
if curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
  echo "    OK: app responds on 127.0.0.1:${PORT}"
else
  echo "    FAIL: nothing on 127.0.0.1:${PORT} — fix PM2/deploy first."
fi
echo ""

echo "==> 2) PM2 (user: $DEPLOY_USER) — empty 'ubuntu' pm2 list is normal"
sudo -u "$DEPLOY_USER" -H pm2 list 2>/dev/null || echo "    (cannot run pm2 as $DEPLOY_USER)"
echo ""

echo "==> 3) What listens on ${PORT}"
ss -tlnp 2>/dev/null | grep ":${PORT}" || echo "    nothing listening on ${PORT}"
echo ""

echo "==> 4) Nginx"
systemctl is-active nginx 2>/dev/null || true
sudo nginx -t 2>&1 || true
if [ -f /etc/nginx/sites-enabled/interviewveil-api ]; then
  echo "    sites-enabled: interviewveil-api present"
  grep -E 'server_name|listen |proxy_pass' /etc/nginx/sites-enabled/interviewveil-api 2>/dev/null | head -20 || true
else
  echo "    MISSING: /etc/nginx/sites-enabled/interviewveil-api"
  echo "    Fix: API_DOMAIN=${API_DOMAIN} bash ${APP_DIR}/deploy/native/install-nginx-site.sh"
fi
echo ""

echo "==> 5) HTTP/HTTPS from this server (Host: $API_DOMAIN)"
for scheme in http https; do
  code=$(curl -sS -o /tmp/iv-health-body -w "%{http_code}" --connect-timeout 5 \
    -H "Host: ${API_DOMAIN}" "${scheme}://127.0.0.1/health" 2>/dev/null || echo "000")
  body=$(head -c 80 /tmp/iv-health-body 2>/dev/null || true)
  echo "    ${scheme}://127.0.0.1/health (Host header) → HTTP ${code} ${body}"
done
echo ""

echo "==> 6) Public DNS for ${API_DOMAIN}"
if command -v dig >/dev/null; then
  dig +short "$API_DOMAIN" A 2>/dev/null || true
else
  getent hosts "$API_DOMAIN" 2>/dev/null || true
fi
echo "    This instance IPs:"
curl -fsS --connect-timeout 2 https://checkip.amazonaws.com 2>/dev/null || hostname -I
echo ""

echo "==> 7) UFW (needs 80/443 open)"
sudo ufw status 2>/dev/null | head -15 || true
echo ""

echo "========== Typical fixes =========="
echo "• Nginx site missing: API_DOMAIN=${API_DOMAIN} bash deploy/native/install-nginx-site.sh"
echo "• HTTPS missing: sudo certbot --nginx -d ${API_DOMAIN}"
echo "• App down: sudo -u ${DEPLOY_USER} -H bash -lc 'cd ${APP_DIR} && bash deploy/native/release-deploy.sh'"
echo "• AWS: security group must allow inbound TCP 80 and 443 from 0.0.0.0/0"
echo "• DNS A record for ${API_DOMAIN} must point to this server's public IP"
echo "• Check PM2: sudo -u ${DEPLOY_USER} -H pm2 list   (not plain pm2 as ubuntu)"
