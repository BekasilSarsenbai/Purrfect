# Assignment Compliance Matrix

This file maps assignment requirements to implemented evidence in the repository.

## 1) Bootstrap & Infrastructure

- Environment validation with fail-fast startup:
  - `src/config/env.js`
- Prisma client singleton + graceful disconnect:
  - `src/config/prisma.js`
  - `src/server.js`
- Baseline migration matching project schema:
  - `prisma/schema.prisma`
  - `prisma/migrations/20260427144000_init_full_schema/migration.sql`
- Setup + architecture docs:
  - `README.md`
  - `architecture.txt`
  - `CHANGELOG.md`

## 2) Authentication & Authorization (Mandatory Baseline)

- Register, Login, Refresh, Logout:
  - `src/routes/auth.routes.js`
- Password hashing:
  - `argon2` in `src/routes/auth.routes.js`
- Access + refresh JWT:
  - `src/services/token-service.js`
- Refresh token revocation/rotation:
  - `src/routes/auth.routes.js`
  - `RefreshToken` model in `prisma/schema.prisma`
- RBAC middleware with explicit `403`:
  - `src/middleware/auth.js`
- Rate limiting on auth endpoints:
  - `src/middleware/rate-limit.js`
  - attached to `/auth/register` and `/auth/login`
- CORS configuration:
  - `src/app.js`
  - `CORS_ORIGINS` in `.env.example`
- Swagger docs:
  - `openapi.yaml`
  - mounted at `/docs` in `src/app.js`

## 3) Core Business Logic

- Foundational escrow purchase flow:
  - `POST /orders` in `src/routes/orders.routes.js`
- Handover transition and first payout release:
  - `POST /orders/:orderId/handover-confirm` in `src/routes/orders.routes.js`
- Inspection gate:
  - `src/routes/inspections.routes.js`
- Dispute lifecycle and evidence:
  - `src/routes/disputes.routes.js`
- Moderator dispute resolution:
  - `src/routes/moderation.routes.js`
- Admin controls:
  - `src/routes/admin.routes.js`

## 4) API Docs & Contract

- OpenAPI contract:
  - `openapi.yaml`
- Swagger UI mount:
  - `src/app.js`
- Standardized error payload:
  - `src/middleware/error-handler.js`
  - `src/utils/errors.js`
- Cursor pagination implemented:
  - `GET /orders`, `GET /listings`, `GET /disputes`, moderation/admin lists

## 5) Testing & QA

- Unit tests:
  - `tests/unit/settlement-service.test.js`
- Integration tests:
  - `tests/integration/order-atomicity.test.js`
  - `tests/integration/auth-rbac.test.js`
- CI (lint + tests + docker build):
  - `.github/workflows/ci.yml`

## 6) Containerization

- Docker image:
  - `Dockerfile`
- Multi-service runtime:
  - `docker-compose.yml`
- Local run:
  - `docker compose up --build`
