# Deploying the API to AWS (free tier)

The setup below fits the AWS free tier. The free tier includes 750 h/month of a `t2.micro`/`t3.micro` instance and of a `db.t3.micro`/`db.t4g.micro` database (20 GB), both for the first 12 months.

```
Internet ──► Caddy (HTTPS) ──► API container ──► RDS Postgres
            └────── one EC2 instance ──────┘
```

## 1. Database (RDS)

1. In the RDS console, choose **Create database**: PostgreSQL 16, template **Free tier**, `db.t4g.micro`.
2. Settings:
   - Set a username (e.g. `interviewveil`) and a strong password.
   - Initial database name: `interviewveil`.
   - **Public access: No.**
3. The EC2 instance must be able to reach the database. Give RDS a security group that allows port 5432 **only from the EC2 instance's security group**.
4. Note the endpoint, then build the connection string (RDS uses SSL; the image ships the RDS CA):

   ```
   postgres://interviewveil:PASSWORD@<endpoint>:5432/interviewveil?sslmode=verify-full&sslrootcert=/app/rds-ca.pem
   ```

## 2. Server (EC2)

1. Launch an instance: **Amazon Linux 2023**, `t3.micro` (or `t2.micro`).
2. Security group: allow **22** (SSH, your IP only), **80** and **443** (anywhere).
3. Allocate an **Elastic IP** and attach it, so the address survives reboots.
4. DNS: add an `A` record `api.interviewveil.app` → the Elastic IP.
5. SSH in and set up:

   ```bash
   git clone <your repo> interviewveil && cd interviewveil/backend
   bash deploy/ec2-setup.sh   # Docker, Compose, 2 GB swap
   exit                       # log back in so the docker group applies
   ```

6. Create `backend/.env` from `.env.example` and fill in at least:
   - `PUBLIC_URL`, `API_DOMAIN`, `WEB_URL`, `COOKIE_DOMAIN`
   - `DATABASE_URL` (from step 1)
   - `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID` if using an unscoped user key)
   - `STT_API_KEY`
   - the Stripe keys
   - the Google and GitHub OAuth keys
   - `BREVO_API_KEY`, `EMAIL_FROM`

7. Start it:

   ```bash
   cd interviewveil/backend
   docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
   docker compose -f deploy/docker-compose.yml logs -f api
   ```

   Caddy fetches the HTTPS certificate automatically on first start (DNS must already point at the instance). Database migrations run each time the API starts.

8. Check it: `curl https://api.interviewveil.app/health` should return `{"ok":true}`.

## 3. Third-party settings

- **Stripe (live mode):**
  - Run `docker compose -f deploy/docker-compose.yml exec api node dist/billing/setup.js`, or run `npm run stripe:setup` locally with the live key.
  - Add a webhook `https://api.interviewveil.app/webhooks/stripe` with these events:
    - `checkout.session.completed`
    - `customer.subscription.created`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `invoice.paid`
  - Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
- **Google / GitHub OAuth:** set the callback URLs to `https://api.interviewveil.app/auth/google/callback` and `.../auth/github/callback`.
- **Brevo:** verify the sender domain/address used in `EMAIL_FROM` and create an API key.

## Updating

```bash
cd interviewveil && git pull
cd backend && docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

## Notes

- **One instance only (for now).** Rate limits are kept in memory. Move them to Redis before running more than one API container.
- **Backups.** Turn on RDS automated backups (7 days is included in the free tier).
- **After 12 months the free tier ends.** Expect roughly $15–20/month for `t3.micro` plus `db.t4g.micro`.
