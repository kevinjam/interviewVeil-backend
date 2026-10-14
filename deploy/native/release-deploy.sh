#!/usr/bin/env bash
# Production deploy on the server (after git pull or CI sync). No Docker.
# Run from anywhere in the repo or from backend/:
#   bash backend/deploy/native/release-deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$BACKEND_DIR"

if [[ ! -f package-lock.json ]]; then
  echo "Expected backend/ with package-lock.json; got $BACKEND_DIR"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing $BACKEND_DIR/.env — copy from .env.example and configure production secrets."
  exit 1
fi

echo "==> npm ci (production)"
npm ci --omit=dev

echo "==> build"
npm run build

echo "==> migrations"
npm run db:migrate

echo "==> PM2"
if pm2 describe interviewveil-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-8787}"

echo "==> health check"
curl -fsS --retry 5 --retry-delay 2 "http://127.0.0.1:${PORT}/health"
echo ""
echo "Deploy finished. interviewveil-api is running on port ${PORT}."
