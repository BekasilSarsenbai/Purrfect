# Purrfect Backend

Production-grade backend for the Purrfect cat marketplace — escrow-based payments,
veterinary inspection gate, evidence-driven disputes, asynchronous email notifications.

## Stack

- Node.js + Express 5
- Prisma ORM (zero raw SQL — every DB write goes through the ORM)
- PostgreSQL 15
- Redis 7 — sliding-window auth rate limiting, password-reset tokens, BullMQ broker
- BullMQ — email queue + cron scheduler
- Resend — transactional email provider (with `EMAIL_DELIVERY_MODE=log` fallback for dev)
- JWT access (15m) + refresh (7d) with rotation, reuse-detection
- RBAC (4 roles: BUYER / SELLER / MODERATOR / ADMIN)
- Email verification gate on every business-write endpoint

## Local Run (Docker)

```bash
cp .env.example .env
docker compose up --build
```

## Local Run (without Docker)

If Docker is not available, run against local Postgres + Redis:

```bash
# 1. Postgres + Redis
brew services start postgresql@15
brew install redis && brew services start redis

# 2. Create the database
PGPASSWORD=123456 createdb -h localhost -U postgres purrfect

# 3. In .env set DATABASE_URL=postgresql://postgres:123456@localhost:5432/purrfect?schema=public
#    and REDIS_URL=redis://localhost:6379

# 4. Migrations, admin seeder, API + worker (use two terminals)
npm ci
npx prisma migrate deploy
npm run seed:admin       # upserts ADMIN from ADMIN_EMAIL/PASSWORD in .env
npm start                # API on :3000
npm run worker           # separate process — email queue + cron
```

- API: `http://localhost:3000`
- Health: `/health`, `/health/live`, `/health/ready`
- Swagger UI: `http://localhost:3000/docs`
- Email queue stats (ADMIN-only): `GET /admin/queues/email/stats`

## Async Workflow Architecture

Email delivery and recurring jobs run in a **separate process** (`npm run worker`)
connected to the same Redis. The API enqueues jobs via `enqueueEmail()` and
responds immediately; the worker processes them asynchronously.

```
┌──────────┐ enqueueEmail()  ┌────────────────┐  Resend API
│   API    │ ─────────────► │  BullMQ queue   │ ──────────►
│ (Express)│                 │  (Redis)        │
└──────────┘                 └─────┬───────────┘
                                   │ pull
                          ┌────────▼──────────┐
                          │  npm run worker   │
                          │  email-worker.js  │
                          └────────┬──────────┘
                                   │ scheduled
                              ┌────▼─────┐
                              │ cron jobs │
                              └──────────┘
```

Cron schedule (BullMQ repeatables, registered on worker boot):

| Job | Cron | What it does |
|---|---|---|
| `inspection-deadline-reminder` | `0 * * * *` (hourly) | Finds orders in `INSPECTION_ACTIVE` whose deadline lands within the next 24h and queues reminder emails. Idempotency: `{orderId, hour-bucket}`. |
| `stale-verification-cleanup` | `30 3 * * *` (daily, 03:30) | Wipes expired `emailVerificationToken*` columns (>24h past expiry). |

Email queue retry policy: `attempts=3`, exponential backoff `5s → 25s → 125s`.

## Auth Endpoints

- `POST /auth/register` — sends verification email asynchronously via the worker queue. New users have `emailVerifiedAt = null` until they confirm.
- `POST /auth/verify-email` — accepts `{ token }`; one-time use, 24h TTL.
- `POST /auth/resend-verification` — rate-limited; always returns 200 to prevent email enumeration.
- `POST /auth/login` — credential check; returns access (15m) + refresh (7d).
- `POST /auth/refresh` — rotates refresh; replays trigger reuse detection and revoke the whole token family.
- `POST /auth/logout`, `POST /auth/logout-all`
- `POST /auth/forgot-password` — queues a real password-reset email; Redis-backed token, 15-minute TTL.
- `POST /auth/reset-password` — sets new password and revokes every refresh token.

## Users

- `GET /users/me`, `PATCH /users/me/profile`, `POST /users/me/account/delete`
- `POST /users/me/change-password`
- `GET /users/me/sessions`, `DELETE /users/me/sessions/{id}`
- `GET /users/me/stats`
- `GET /users/me/notifications`, `PATCH /users/me/notifications/{id}/read`, `POST /users/me/notifications/mark-all-read`
- `GET /users/{userId}` — public profile

## Listings

- `GET /listings`, `GET /listings/search`, `GET /listings/me`
- `POST /listings`, `GET /listings/{id}`, `PATCH /listings/{id}`, `DELETE /listings/{id}`
- `POST /listings/{id}/submit-review`, `POST /listings/{id}/republish`, `POST /listings/{id}/report`
- `POST/GET /listings/{id}/media`, `DELETE /listings/{id}/media/{mediaId}`
- `POST/GET /listings/{id}/documents`, `DELETE /listings/{id}/documents/{docId}`
- `POST /listings/{id}/documents/{docId}/verify`

`GET /listings/{id}` returns 404 for non-public statuses unless caller is owner / MODERATOR / ADMIN.

## Orders & Inspections

- `POST /orders` — atomic escrow + payouts + reservation. Concurrency-safe via Prisma `updateMany` compare-and-swap (no raw SQL). **Side-effect: queues `order.created.seller` email + writes in-app Notification.**
- `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`
- `POST /orders/{id}/handover-confirm` — milestone-1 release + 72h inspection window. **Side-effect: queues `order.handover.seller` email + writes in-app Notification.**
- `POST /orders/{id}/inspection` (FAILED outcome auto-opens a dispute)
- `POST /orders/{id}/inspection/approve` — milestone-2 release. **Side-effect: queues `order.completed.seller` email + writes in-app Notification.**
- `GET /orders/{id}/transactions`, `/payouts`, `/timeline`, `/audit`

## Disputes

- `POST /disputes`, `GET /disputes`, `GET /disputes/{id}`
- `POST /disputes/{id}/evidence`, `GET /disputes/{id}/evidence`
- `POST /disputes/{id}/comments`, `GET /disputes/{id}/comments`
- `POST /disputes/{id}/reopen` (14-day window)

## Moderation

- `GET/PATCH /moderation/cases`, `PATCH /moderation/cases/{id}/close`
- `GET /moderation/disputes`, `POST /moderation/disputes/{id}/resolve`
- `GET /moderation/listings`, `POST /moderation/listings/{id}/approve`, `POST /moderation/listings/{id}/reject`
- `POST /moderation/listings/{id}/risk-flag`, `POST /moderation/listings/{id}/risk-flag/clear`
- `GET /moderation/listings/{id}/risk-signals`, `GET /moderation/listings/{id}/full-context`

## Admin

- `PATCH /admin/users/{id}/role`, `PATCH /admin/users/{id}/status` — last-active-admin guard
- `GET /admin/users`, `GET /admin/orders`, `POST /admin/orders/{id}/force-complete`
- `GET /admin/audit-logs`, `GET /admin/dashboard-kpis`, `GET /admin/financial-summary`

## Architecture Notes

- **Zero raw SQL.** Every query goes through Prisma. Concurrency control on `POST /orders` is done with an atomic `listing.updateMany({where: {status: PUBLISHED}})` compare-and-swap — when two buyers race, only one `UPDATE` matches a `PUBLISHED` row, the other gets `count=0` and is rejected with 409. Equivalent to a row-level write lock without `SELECT FOR UPDATE`.
- **Email verification gate.** `requireVerifiedEmail` middleware on every BUYER/SELLER write endpoint — unverified users get `403 EMAIL_NOT_VERIFIED`. ADMIN/MODERATOR pass through (created via seed / `POST /admin/users`).
- **Side-effect ordering.** Emails are queued *after* the DB transaction commits. If the queue push fails, the user-facing action still succeeded; if the transaction fails, no email is sent. Reverse order would create ghost notifications.
- **Idempotent enqueues.** Every email job carries an `idempotencyKey` (`notify:order-created:{orderId}`, `verify-email:{userId}:initial`, etc.) — BullMQ deduplicates retries.
- **Rate limiting.** Redis sorted-set sliding window: 5 req / 60s / IP on `/auth/login`, `/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/resend-verification`.
- **Refresh token rotation** with reuse detection — replay revokes the entire family; family rotation tracked via `familyId`, individual tokens deduped via `jti`.
- **AuditLog** is written for: admin role/status changes, admin-created users, dispute open/resolve/reopen, listing approve/reject, force-complete, moderation case close, auto-dispute.
- **Listing publish** requires every `ListingDocument` to have a latest `APPROVED` verification.
- `EscrowTransaction.idempotencyKey` includes a counter of prior refund/payout attempts so reopen-cycles don't collide.
- `errorHandler` translates Prisma `P2002` → 409, `P2003` → 409, `P2025` → 404.

## Scripts

- `npm run dev` / `npm start` — API
- `npm run worker` — BullMQ worker (email queue + cron). Run in a separate terminal.
- `npm run seed:admin` — upsert ADMIN account from `.env` (`ADMIN_EMAIL`/`ADMIN_PASSWORD`)
- `npm run lint`
- `npm run test`, `npm run test:unit`, `npm run test:integration`
- `npm run prisma:migrate`, `npm run prisma:deploy`

## Security Note

`.env` is ignored. Use `.env.example` as the committed reference.
