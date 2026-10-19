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

## Private GitHub repo — clone on the server

`git clone https://github.com/...` on a **private** repo will stop and ask for a username/password. GitHub no longer accepts account passwords for Git over HTTPS; use **SSH + a deploy key** instead.

On EC2 (as the user that will own the app, e.g. `deploy`):

```bash
# Cancel any stuck HTTPS clone, then remove a failed partial directory:
#   Ctrl+C
#   sudo rm -rf /var/www/interviewveil

sudo mkdir -p /var/www
sudo chown deploy:deploy /var/www

sudo -u deploy bash -lc '
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  test -f ~/.ssh/github_deploy || ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "interviewveil-ec2-git"
  cat >> ~/.ssh/config <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
  chmod 600 ~/.ssh/config
  echo "Add this deploy key in GitHub (read-only):"
  cat ~/.ssh/github_deploy.pub
'
```

In GitHub: **interviewVeil-backend → Settings → Deploy keys → Add deploy key** — paste the `.pub` line, enable **Allow read access** (write not needed). Then:

```bash
sudo -u deploy ssh -o StrictHostKeyChecking=accept-new -T git@github.com
# expect: "Hi kevinjam/interviewVeil-backend! You've successfully authenticated..."

sudo -u deploy git clone git@github.com:kevinjam/interviewVeil-backend.git /var/www/interviewveil
```

GitHub Actions runs `git pull` on the server during deploy; this deploy key is what lets `deploy` pull without a password.

**Do not confuse** this key with the **Actions SSH key** (GitHub secret `SSH_PRIVATE_KEY` → `authorized_keys` on the server so Actions can SSH in). You need **both**: Actions → server SSH, and server → GitHub deploy key.

## First-time server setup

1. Create a deploy user, [clone with a deploy key](#private-github-repo--clone-on-the-server) into `/var/www/interviewveil`.
2. From the repo root on the server:

   ```bash
   INSTALL_LOCAL_POSTGRES=1 bash deploy/native/ubuntu-bootstrap.sh
   ```

   Omit `INSTALL_LOCAL_POSTGRES=1` if you use RDS or another managed database.

3. Configure secrets:

   ```bash
   cp .env.example .env
   # Or copy your local production file (gitignored): scp .env.prod → server .env
   chmod 600 .env
   # NODE_ENV=production, PUBLIC_URL, DATABASE_URL, keys, …
   ```

4. Nginx + TLS:

   ```bash
   API_DOMAIN=api.yourdomain.com bash deploy/native/install-nginx-site.sh
   sudo certbot --nginx -d api.yourdomain.com
   ```

5. First deploy:

   ```bash
   bash deploy/native/release-deploy.sh
   pm2 startup systemd -u "$USER" --hp "$HOME"
   pm2 save
   ```

6. Backups (local Postgres): schedule `backup-db.sh` in cron.

## Updates

```bash
cd /var/www/interviewveil
git pull
bash deploy/native/release-deploy.sh
```

## GitHub Actions → AWS

The workflow [`.github/workflows/backend-deploy.yml`](../../.github/workflows/backend-deploy.yml) runs on push to `main` (and manual **Run workflow**). It does **not** use GitHub **Environments** today—only **repository secrets**. Environments are optional (see below).

### 1. AWS (one-time)

1. **EC2** — Ubuntu 24.04, `t3.micro` (or similar). Security group: **22** from your IP, **80/443** from the internet.
2. **Database** — RDS PostgreSQL (recommended on AWS) **or** Postgres on the same EC2 (`INSTALL_LOCAL_POSTGRES=1` in bootstrap). Put `DATABASE_URL` in server `backend/.env` only.
3. **DNS** — `A` record for your API host → EC2 public IP (or Elastic IP).
4. On the instance: bootstrap, Nginx, Certbot, clone **this repo**, create `.env`, first `release-deploy.sh`, `pm2 startup` (steps above).

### 2. Deploy user and SSH key

On your laptop:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/interviewveil-deploy -N ""
```

On EC2 (as `deploy` or your app user):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<paste contents of interviewveil-deploy.pub>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Clone the backend repo (this repository):

```bash
git clone git@github.com:kevinjam/interviewVeil-backend.git /var/www/interviewveil
cd /var/www/interviewveil
cp .env.example .env && chmod 600 .env
# fill .env (NODE_ENV=production, DATABASE_URL, Stripe, OAuth, …)
```

### 3. GitHub repository secrets

In **GitHub → interviewVeil-backend → Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Example | Required |
| --- | --- | --- |
| `SSH_HOST` | EC2 public IP or `api.example.com` | Yes, for deploy job to run |
| `SSH_USER` | **`deploy`** if the repo was cloned with `sudo -u deploy` (recommended) | Yes |

The clone under `/var/www/interviewveil` must be owned by **`deploy`**. GitHub SSH must run deploy steps as that user:

- **Recommended:** `SSH_USER` = **`deploy`** (private key in `deploy`’s `~/.ssh/authorized_keys`).
- **If `SSH_USER` is `ubuntu`:** allow passwordless sudo to deploy (one-time on EC2):

  ```bash
  echo 'ubuntu ALL=(deploy) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/github-deploy
  sudo chmod 440 /etc/sudoers.d/github-deploy
  ```

  The workflow runs `sudo -u deploy …/pull-and-deploy.sh` so `git pull` and `pm2` use the correct user.
| `SSH_PRIVATE_KEY` | Full contents of `interviewveil-deploy` (private key) | Yes |
| `SSH_PORT` | `22` | No |
| `DEPLOY_PATH` | `/var/www/interviewveil` | No (default shown) |

Until `SSH_HOST` is set, CI still **tests and builds** on every push; the **deploy** job is skipped.

**Do not** put `DATABASE_URL`, Stripe keys, or API keys in GitHub—those stay in `/var/www/interviewveil/.env` on the server only.

### 4. GitHub Environments (optional)

You do **not** need an Environment for the current workflow. Add one later if you want:

- **Required reviewers** before production deploy
- Separate secrets for `staging` vs `production`
- Deployment branch rules

To use environments, create **Settings → Environments → production**, move SSH secrets there, and add to the deploy job:

```yaml
environment: production
```

### 5. First deploy from GitHub

1. Confirm server manual deploy works: `bash deploy/native/release-deploy.sh`.
2. Add the four SSH secrets.
3. Push to `main` or run **Actions → Deploy backend → Run workflow**.
4. Check `curl -fsS https://<your-api>/health`.

## Verify

```bash
curl -fsS https://api.yourdomain.com/health
```

## `pm2 list` is empty (but deploy just succeeded)

Your deploy log shows `user │ deploy` in the PM2 table. If you SSH as **`ubuntu`** and run `pm2 list`, you will always see an **empty** table — that is a **different** PM2 home directory, not proof the API stopped.

```bash
# Correct (from any login user):
sudo -u deploy -H pm2 list
bash /var/www/interviewveil/deploy/native/status.sh
```

Wrong (misleading):

```bash
ubuntu@server:~$ pm2 list   # empty — ignores deploy’s processes
```

## `pm2 list` is empty for deploy too

PM2 keeps its process list **per Linux user** (`~/.pm2`). Common causes:

1. **Wrong user** — You SSH as `ubuntu` but the app runs under `deploy`:
   ```bash
   sudo -u deploy -H pm2 list
   sudo -u deploy -H pm2 logs interviewveil-api --lines 50
   ```
2. **Reboot** — Processes do not come back until **startup** was configured for that user:
   ```bash
   sudo -u deploy -H bash -lc 'cd /var/www/interviewveil && pm2 start ecosystem.config.cjs && pm2 save'
   sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u deploy -hp /home/deploy
   # Run the command `pm2 startup` prints, then:
   sudo -u deploy -H pm2 save
   ```
3. **Deploy never finished PM2** — Re-run deploy as `deploy`:
   ```bash
   sudo -u deploy -H bash -lc 'cd /var/www/interviewveil && bash deploy/native/release-deploy.sh'
   ```

Quick health check without PM2:

```bash
curl -fsS http://127.0.0.1:8787/health
ss -tlnp | grep 8787
```
