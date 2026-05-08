# CHANGELOG

## 2026-05-08 — Sprint 2 (final pre-defense)

### Mandatory compliance fixes

- **Removed all raw SQL.** `prisma.$queryRaw\`SELECT 1\`` in the readiness probe replaced with `prisma.user.count()` (ORM call). `tx.$queryRaw\`SELECT FOR UPDATE\`` in `POST /orders` replaced with an atomic `tx.listing.updateMany({where: {status: PUBLISHED}, data: {status: RESERVED}})` compare-and-swap — equivalent row-level write lock without leaving the ORM. The repo now contains zero `$queryRaw` / `$executeRaw` calls. Verified by `grep -rn "queryRaw\|executeRaw" src/`.
- **Architectural justification for the swap:** Prisma does not expose `SELECT FOR UPDATE` through the ORM client. The compare-and-swap pattern provides identical safety: the database serialises concurrent UPDATEs on the same row, and only one transaction can see `status='PUBLISHED'` and flip it to `RESERVED`. The losing transaction gets `count=0` and is rejected with HTTP 409 — the same outcome as the raw lock.

### New features

- **Email verification on signup.** Registration now generates a SHA-256 hashed token (24h TTL) stored on the `User` row and queues an `auth.verify` email via the BullMQ worker. New endpoints: `POST /auth/verify-email`, `POST /auth/resend-verification` (rate-limited, anti-enumeration). New middleware `requireVerifiedEmail` rejects unverified BUYER/SELLER on every business-write endpoint with `403 EMAIL_NOT_VERIFIED`. ADMIN/MODERATOR pass through (privileged accounts are seeded or admin-created and trusted).
- **Real password reset email.** `/auth/forgot-password` no longer leaks `devToken` in the response — the reset link is sent via the queue.
- **In-app + email notifications on business events.** `POST /orders`, `POST /orders/:id/handover-confirm`, `POST /orders/:id/inspection/approve`, and `POST /disputes` each write a `Notification` row inside the same Prisma transaction and queue the matching email *after* the transaction commits. Templates: `order.created.seller`, `order.handover.seller`, `order.completed.seller`, `dispute.opened.seller`. All emails carry idempotency keys for safe retries.
- **BullMQ worker (`npm run worker`).** Two queues: `email` (concurrency 5, attempts 3, exponential backoff 5s/25s/125s) and `cron` (concurrency 1). Repeatable jobs registered on boot:
  - `inspection-deadline-reminder` — every hour, finds buyers with <24h until inspection deadline and queues reminder email; idempotent per `{orderId, hour-bucket}`.
  - `stale-verification-cleanup` — daily 03:30, nulls out expired verification tokens (>24h after expiry).
- **Admin queue observability.** New endpoint `GET /admin/queues/email/stats` returns counts per state (active/completed/failed/delayed/waiting/paused) and attached workers.

### Schema changes

- Migration `20260508120000_add_email_verification`: added `User.emailVerifiedAt`, `User.emailVerificationTokenHash` (unique), `User.emailVerificationExpiresAt`.

### Tooling / config

- New `EMAIL_DELIVERY_MODE` env var: `live` calls Resend, `log` (default) prints rendered emails to stdout — usable in tests, demos, and CI without a real API key.
- New env vars: `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`. All Zod-validated; missing values fail boot.
- Added `npm run worker` script.

### Tests

- New unit test `tests/unit/email-service.test.js` (5 cases): template registry, link rendering, HTML escaping, KZT formatting, error on unknown template.
- Updated `tests/integration/order-atomicity.test.js` helper to stamp `emailVerifiedAt` directly via Prisma so business-flow tests pass through the new verification gate.
- Suite total: **12 tests, all passing**.

## 2026-04-27

- Initialized backend project with Express + Prisma + Docker.
- Added authentication baseline endpoints with JWT access/refresh and RBAC middleware.
- Added admin role update endpoint.
- Added initial order transaction flow (`create order`, `handover confirm`) with Prisma transactions.
- Mounted Swagger UI at `/docs` from `openapi.yaml`.
- Expanded API with seller asset endpoints, moderation listing workflow, and order insight endpoints.
- Added advanced security endpoints (`logout-all`, password rotation, session management).
- Added moderation case APIs, dispute reopen flow, and admin dashboard KPIs.
- Synced `openapi.yaml` with newly implemented routes and standardized error response coverage.

## Sprint 1 Fixes

- **Redis rate limiting**: replaced memory-based `express-rate-limit` with a Redis sliding-window
  implementation (`ioredis` + sorted-set pipeline). Key: `rate:auth:{ip}`, 5 req / 60 s window.
  Redis client extracted to `src/config/redis.js`; server shutdown calls `closeRedis()`.
- **CI Redis service**: added `redis:7-alpine` service to `.github/workflows/ci.yml` with health check
  so integration tests have a live Redis instance.
- **COMPLEXITY_REQ_5 tagged**: `POST /orders/:orderId/inspection/approve` in `inspections.routes.js`
  is now explicitly marked — inspection-gated final payout release where milestone 2 is only
  disbursed after a PASSED vet report, inside a single atomic Prisma `$transaction`.
- **Unit test coverage expanded**: `settlement-service.test.js` now has 5 test cases covering
  even splits, payout invariant, zero fee, Prisma Decimal coercion, and exact percentage math.
- **Security note**: `.env` is listed in `.gitignore`; run `git rm --cached .env` once to remove
  it from git history tracking. Use `.env.example` as the committed reference.

### Contract Notes

- Current codebase includes all Sprint 1 mandatory baseline requirements and extended operational endpoints for defense depth.
- Additional endpoints not present in the original blueprint were intentionally added for observability, security operations, and moderation workflows.
- All 5 COMPLEXITY_REQ tags are present: REQ_1 (escrow hold), REQ_2 (inspection gate 72h deadline),
  REQ_3 (evidence-driven dispute engine), REQ_4 (moderation triage queue), REQ_5 (inspection-gated final payout).

## 2026-04-30 — Hardening + endpoint expansion

Bug fixes:

- `GET /listings/{id}` no longer leaks DRAFT / PENDING_REVIEW / REJECTED / ARCHIVED listings to the public; non-public statuses return 404 unless caller is owner / MODERATOR / ADMIN.
- `POST /orders` now uses `SELECT ... FOR UPDATE` on the listing row, fixing the documented double-book race condition.
- `POST /auth/refresh` now performs reuse-detection: a replay of an already-revoked token revokes the entire token family.
- Moderation `resolve` no longer collides on idempotency keys after a reopen + re-resolve cycle (counter-based suffix on `EscrowTransaction.idempotencyKey`).
- `REFUND_FULL` resolution now subtracts an already-released milestone-1 amount from the refund total instead of double-paying.
- `REFUND_PARTIAL` now rejects amounts greater than `totalAmountKzt` with 422.
- `PATCH /admin/users/{id}/role` and `/status` now refuse to demote / suspend / delete the last active admin.
- Listing `approve` now refuses to publish a listing while any document is pending or rejected.
- `errorHandler` translates Prisma `P2002` → 409, `P2003` → 409, `P2025` → 404 instead of leaking 500s.

New endpoints:

- Auth: `POST /auth/forgot-password`, `POST /auth/reset-password`
- Users: `PATCH /users/me/profile`, `DELETE /users/me/account`, `GET /users/me/stats`, `GET/PATCH /users/me/notifications`, `POST /users/me/notifications/mark-all-read`, `GET /users/{userId}`
- Listings: `GET /listings/me`, `GET /listings/search`, `POST /listings/{id}/republish`, `POST /listings/{id}/report`, `DELETE /listings/{id}/media/{mediaId}`, `DELETE /listings/{id}/documents/{documentId}`
- Disputes: `GET /disputes/{id}/comments`, `POST /disputes/{id}/comments`
- Moderation: `PATCH /moderation/cases/{id}/close`, `POST /moderation/listings/{id}/risk-flag/clear`, `GET /moderation/listings/{id}/full-context`
- Admin: `GET /admin/users`, `GET /admin/orders`, `POST /admin/orders/{id}/force-complete`, `GET /admin/financial-summary`
- System: `GET /health/live`, `GET /health/ready`

Infra:

- `src/utils/pagination.js` — single Zod-validated cursor/limit parser used across every list endpoint.
- AuditLog is now written for: dispute open/resolve/reopen, auto-dispute from FAILED inspection, listing approve/reject, force-complete, moderation case close, self-account delete.
- Notification inbox endpoints implement the previously unused `Notification` model.
