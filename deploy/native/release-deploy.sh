#!/usr/bin/env bash
# Production deploy on the server (after git pull or CI sync). No Docker.
# Run from anywhere in the repo or from backend/:
#   bash backend/deploy/native/release-deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
git config --global --add safe.directory "$BACKEND_DIR" 2>/dev/null || true
cd "$BACKEND_DIR"
echo "==> deploy $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [[ ! -f package-lock.json ]]; then
  echo "Expected backend/ with package-lock.json; got $BACKEND_DIR"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing $BACKEND_DIR/.env — copy from .env.example and configure production secrets."
  exit 1
fi

echo "==> npm ci"
npm ci

echo "==> build"
npm run build

echo "==> migrations"
node --env-file-if-exists=.env dist/db/migrate.js

echo "==> npm prune (drop devDependencies on server)"
npm prune --omit=dev

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-8787}"

echo "==> boot smoke test (node + .env, port ${PORT})"
set +e
node --env-file-if-exists=.env dist/server.js &
BOOT_PID=$!
sleep 4
if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  kill "$BOOT_PID" 2>/dev/null
  wait "$BOOT_PID" 2>/dev/null
else
  echo "Smoke test failed — app did not listen on ${PORT}"
  kill "$BOOT_PID" 2>/dev/null
  wait "$BOOT_PID" 2>/dev/null
  echo "--- node boot output (5s) ---"
  timeout 5 node --env-file-if-exists=.env dist/server.js 2>&1 || true
  echo "---"
  exit 1
fi
set -e

echo "==> PM2"
pm2 delete interviewveil-api 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "==> health check (port ${PORT})"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "API did not respond on 127.0.0.1:${PORT}/health"
  pm2 status interviewveil-api || true
  pm2 describe interviewveil-api || true
  echo "--- pm2 logs (last 60 lines) ---"
  pm2 logs interviewveil-api --lines 60 --nostream 2>/dev/null || true
  echo "---"
  echo "On the server: pm2 logs interviewveil-api; check .env (NODE_ENV, DATABASE_URL, BREVO_API_KEY)."
  exit 1
fi

curl -fsS "http://127.0.0.1:${PORT}/health"
echo ""
echo "Deploy finished. interviewveil-api is running on port ${PORT}."
