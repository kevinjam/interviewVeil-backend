#!/usr/bin/env bash
# Logical backup for local PostgreSQL (Option A). Install on server via cron.
# RDS: use automated snapshots instead; optional pg_dump over private endpoint.
#
# Cron example (as root):
#   0 3 * * * deploy /var/www/interviewveil/backend/deploy/native/backup-db.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/interviewveil}"
DB_NAME="${DB_NAME:-interviewveil}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.dump"

if command -v pg_dump >/dev/null; then
  pg_dump -Fc "$DB_NAME" -f "$OUT"
else
  sudo -u postgres pg_dump -Fc "$DB_NAME" -f "$OUT"
fi

find "$BACKUP_DIR" -name "${DB_NAME}-*.dump" -mtime +"$RETENTION_DAYS" -delete
echo "Wrote $OUT"
