# Native production deploy (no Docker)

Production uses **Node.js + PM2 + Nginx + PostgreSQL** on Linux. Full runbook: [backend-deployment-plan.md](../../../backend-deployment-plan.md) at the repo root.

Legacy Docker/Caddy instructions remain in [../README.md](../README.md) for reference only.

## Layout

| File | Purpose |
| --- | --- |
| [../../ecosystem.config.cjs](../../ecosystem.config.cjs) | PM2 app definition |
| `ubuntu-bootstrap.sh` | One-time server packages (Node 22, PM2, Nginx, UFW, swap) |
| `nginx-interviewveil-api.conf.template` | Nginx reverse proxy (streaming-friendly) |
| `install-nginx-site.sh` | Install vhost; needs `API_DOMAIN` |
| `release-deploy.sh` | `npm ci`, build, migrate, PM2 reload, local health check |
| `backup-db.sh` | `pg_dump` cron helper for co-located Postgres |

## First-time server setup

1. Create a deploy user and clone the repo, e.g. `/var/www/interviewveil`.
2. From the repo root on the server:

   ```bash
   INSTALL_LOCAL_POSTGRES=1 bash backend/deploy/native/ubuntu-bootstrap.sh
   ```

   Omit `INSTALL_LOCAL_POSTGRES=1` if you use RDS or another managed database.

3. Configure secrets:

   ```bash
   cp backend/.env.example backend/.env
   chmod 600 backend/.env
   # NODE_ENV=production, PUBLIC_URL, DATABASE_URL, keys, …
   ```

4. Nginx + TLS:

   ```bash
   API_DOMAIN=api.yourdomain.com bash backend/deploy/native/install-nginx-site.sh
   sudo certbot --nginx -d api.yourdomain.com
   ```

5. First deploy:

   ```bash
   bash backend/deploy/native/release-deploy.sh
   pm2 startup systemd -u "$USER" --hp "$HOME"
   pm2 save
   ```

6. Backups (local Postgres): schedule `backup-db.sh` in cron.

## Updates

```bash
cd /var/www/interviewveil
git pull
bash backend/deploy/native/release-deploy.sh
```

Or use GitHub Actions: [backend/.github/workflows/backend-deploy.yml](../../.github/workflows/backend-deploy.yml) (requires `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`).

## Verify

```bash
curl -fsS https://api.yourdomain.com/health
```
