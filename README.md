# Purrfect Backend

Production-oriented backend foundation for the Purrfect cat marketplace project.

## Stack

- Node.js + Express
- Prisma ORM
- PostgreSQL 15
- Redis 7
- JWT access/refresh token auth with RBAC

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

## RBAC Example

- `PATCH /admin/users/{userId}/role` requires `ADMIN`.

## Business Endpoints (Sprint Baseline)

- `POST /orders` (BUYER only)
- `POST /orders/{orderId}/handover-confirm` (BUYER only)
- `GET /orders` (cursor pagination)

## Scripts

- `npm run dev`
- `npm run start`
- `npm run lint`
- `npm run test`
- `npm run prisma:migrate`
- `npm run prisma:deploy`

## Architecture Notes

- Environment fails fast if required secrets are missing.
- Refresh token rotation is implemented with hashed token storage and revocation tracking.
- Financial state changes in order flow run inside Prisma transactions.
