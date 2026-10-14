#!/usr/bin/env bash
# Git pull + release-deploy. Must run as the user that owns /var/www/interviewveil (usually deploy).
set -euo pipefail

APP="${DEPLOY_PATH:-/var/www/interviewveil}"

git config --global --add safe.directory "$APP" 2>/dev/null || true
cd "$APP"
git fetch origin
git checkout main
git pull --ff-only origin main
bash deploy/native/release-deploy.sh
