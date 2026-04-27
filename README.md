# Purrfect Backend

Production-oriented backend foundation for the Purrfect cat marketplace project.

## Stack

- Node.js + Express
- Prisma ORM
- PostgreSQL 15
- Redis 7 (sliding-window rate limiting on auth endpoints)
- JWT access/refresh token auth with RBAC (4 roles: BUYER / SELLER / MODERATOR / ADMIN)

## Local Run (Docker)

1. Copy env file:

```bash
cp .env.example .env
```

2. Start services:

```bash
docker compose up --build
```

3. API endpoints:

- API base: `http://localhost:3000`
- Health: `http://localhost:3000/health`
- Swagger docs: `http://localhost:3000/docs`

## Auth Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/logout-all`

## RBAC Example

- `PATCH /admin/users/{userId}/role` requires `ADMIN`.
- `POST /orders` requires `BUYER`.
- `POST /listings` requires `SELLER`.
- `GET /moderation/disputes` requires `MODERATOR` or `ADMIN`.

## Business Endpoints (Sprint Baseline)

- `POST /orders` — escrow hold + atomic payout creation (COMPLEXITY_REQ_1)
- `POST /orders/:id/handover-confirm` — inspection gate with 72h deadline (COMPLEXITY_REQ_2)
- `POST /disputes` — evidence-driven dispute engine (COMPLEXITY_REQ_3)
- `GET /moderation/disputes` — moderation triage queue (COMPLEXITY_REQ_4)
- `POST /orders/:id/inspection/approve` — inspection-gated final payout (COMPLEXITY_REQ_5)
- `GET /orders` — cursor-based pagination

## Scripts

- `npm run dev`
- `npm run start`
- `npm run lint`
- `npm run test`
- `npm run test:unit`
- `npm run test:integration`
- `npm run prisma:migrate`
- `npm run prisma:deploy`

## Architecture Notes

- Environment fails fast (Zod) if required secrets are missing — including `REDIS_URL`.
- Rate limiting uses a Redis sorted-set sliding window (5 req / 60 s per IP) — not in-memory.
- Refresh token rotation: each refresh revokes the old token and issues a new one atomically.
- Financial state changes in the order flow run inside Prisma `$transaction` — all or nothing.
- Idempotency keys on every `EscrowTransaction` prevent duplicate financial writes.
- Migration baseline is a single full-schema init migration; incremental migrations added as schema evolves.

## Security Note

`.env` is listed in `.gitignore`. If it was previously committed, run once:

```bash
git rm --cached .env
git commit -m "chore: untrack .env"
```

Only `.env.example` should be committed to the repository.
