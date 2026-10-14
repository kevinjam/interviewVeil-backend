# InterviewVeil API (`backend/`)

A Hono server that provides:
- accounts and sign-in (email + password, Google, GitHub, desktop handoff)
- plans, tokens and Stripe billing
- the Claude and transcription proxy used by the desktop app

The website (`../landing`) and the desktop app (`../desktop`) both call it. It's deployed on its own; see [deploy/README.md](deploy/README.md) for AWS.

Data lives in Postgres (Drizzle ORM, SQL migrations in `backend/drizzle/`).

### Run it

```bash
cp .env.example .env        # add any API keys you want to test
npm install
docker compose -f deploy/docker-compose.local.yml up -d
npm run db:migrate
npm run stripe:setup        # creates products, prices, portal config
npm run dev
```

The example environment file uses local URLs and a local Postgres connection. AI, transcription,
OAuth, email, and billing features need their corresponding development credentials; the API can
still start without them, but logs which integrations are not configured.

### Local Postgres container

Only Postgres runs in Docker; run the API directly with `npm run dev` as above. From `backend/`,
start the database container with:

```bash
docker compose -f deploy/docker-compose.local.yml up -d
```

The database is available at `localhost:5433` (host port 5432 is already used on this machine);
the local `.env` settings use the credentials configured in the Compose file. Stop the container with
`docker compose -f deploy/docker-compose.local.yml down`; database data remains in its named
volume. To remove that local database data as well, add `-v` to the `down` command.

Stripe webhooks must reach `POST /webhooks/stripe` with these events:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`

For local testing, run `stripe listen --forward-to localhost:8787/webhooks/stripe`.

### Plans

| Plan | Price | Tokens / month | Model |
|------|-------|----------------|-------|
| Free | $0 | 3 | Haiku (`MODEL_HAIKU`) |
| Essential | $11 | 50 | Haiku (`MODEL_HAIKU`) |
| Professional | $24 | 160 | Sonnet (`MODEL_SONNET`) |
| Expert | $44 | 500 | Opus (`MODEL_OPUS`) |

All plan definitions live in `backend/src/plans.ts`.

**Model routing.** `modelForPlan()` is the only place a model is chosen. The proxy always overwrites the model the client asks for, so a plan can never reach a higher tier.

**Tokens.** 1 token = 1 AI response.

**Listening.** Transcription uses **audio seconds** from your plan (separate from tokens). Each transcribed segment deducts its duration in seconds; failed upstream calls are refunded. The desktop sends WAV segments over **`POST /v1/audio/transcriptions`** (not a WebSocket). Real-time conversation streaming like Tech Screen would be a separate WebSocket endpoint and client work.

**Logging.** Set `LOG_LEVEL=debug` in `.env` for per-request timing on `/v1/*`, `/account`, and `/usage`, plus `[stt]`, `[audio]`, and `[proxy]` lines for transcription and AI proxy.
- Each request holds a token atomically up front, so concurrent requests can't overspend.
- The token is charged only when the response streams to completion without an error or refusal.
- If the request fails, is refused, or the client disconnects, the token is refunded.
- Each charged token is written to `usage_history` (model, kind, input/output tokens).
- At 0 tokens, requests get `402 insufficient_tokens`.
- Free resets monthly. Paid plans reset on each `invoice.paid` renewal.

**Plan changes.**
- **New subscription:** Stripe Checkout.
- **Upgrade:** immediate. The prorated amount is charged now, the new model starts right away, and the new plan's tokens are added to your balance. If the payment fails, nothing changes.
- **Downgrade:** scheduled for the next billing date with a Stripe subscription schedule.
- **Cancel:** takes effect at period end. After that the account returns to Free.
- The customer portal handles invoices, payment methods and cancellation. Plan switching is turned off there so token grants stay consistent.
- Webhooks are idempotent. The event marker is written in the same transaction as its changes.

### Sign-in

- **Methods:** email + password (scrypt), Google, GitHub. Password reset is by emailed link (Brevo).
- **Linking:** signing in with Google or GitHub links to an existing account with the same verified email. If that account's email was never verified, its password and sessions are dropped, so whoever registered the address without owning it loses access.
- **Website:** forms post straight to the API, which sets an HttpOnly session cookie scoped to `COOKIE_DOMAIN` (e.g. `.interviewveil.app`) and redirects back to `WEB_URL`. Only `WEB_URL` may call the API with credentials (CORS), and cookie-authenticated posts from any other origin are rejected (CSRF).
- **Desktop app:** **Sign in with browser** shows a code and opens the website's `/desktop/connect`. You confirm the matching code there, and the app (which is polling) receives its own session token, sent as a header.
- **Storage:** only SHA-256 hashes of session, reset and handoff tokens are stored.

### Support chat

Visitors start a chat from the website's widget, and admins answer from the website's `/admin/chat` inbox.

- **Visitor side:** `POST /chat/conversations` creates a conversation and returns a random token. The browser keeps the token; the server stores only its hash. `GET /chat/messages?after=…&wait=1` is a long-poll that returns the moment a reply arrives. There's also `POST /chat/messages`, `POST /chat/read` and `GET /chat/status`.
- **Admin side:** `/admin/chat/*` covers the conversation list with unread counts, the thread, replies, close/reopen, and a long-poll for updates. Admins are users whose email is in `ADMIN_EMAILS` **and** verified (by Google/GitHub sign-in or a password reset), so registering the address isn't enough.
- **Status in the widget:**
  - *Online* while an admin has the inbox open.
  - *We'll reply soon* inside `SUPPORT_HOURS`.
  - *Outside working hours* otherwise.
  - Hours are evaluated in `SUPPORT_TIMEZONE`.
- **Typing indicators:** `POST /chat/typing` (visitor) and `POST /admin/chat/conversations/:id/typing` (admin). Clients announce at most every 3 seconds while typing and send `false` after 4 seconds idle or on send. The server keeps typing state in memory only and expires it after 6 seconds, so a closed tab never leaves the dots on. Typing wakes only the *other* side's long-poll.
- **Abuse protection:** a honeypot field, a limit of 5 new chats per hour per IP and per email, 20 messages per minute per conversation, and a 4,000-character cap.
- **Scaling:** live updates use an in-process event bus. Move it to Redis or Postgres LISTEN/NOTIFY before running more than one API instance.

### Tests

```bash
DATABASE_URL=postgres://localhost:5432/interviewveil_test npm test --workspace=backend
```

47 tests against a real Postgres cover:
- plan prices and model routing
- token reservation (including a 12-way concurrency race)
- monthly resets
- webhook flows: purchase, renewal, scheduled downgrade, cancellation, replayed events
- auth, CORS and CSRF
- desktop handoff
- the proxy against a fake Anthropic stream: routing, charging and refunds

## Deploy

**Production (native Linux):** [deploy/native/README.md](deploy/native/README.md) and the repo-root [backend-deployment-plan.md](../backend-deployment-plan.md) — PM2, Nginx, Certbot, GitHub Actions over SSH. No containers.

**Legacy reference:** [deploy/README.md](deploy/README.md) (Docker + Caddy on EC2) is kept for history; do not use for new production deploys.
