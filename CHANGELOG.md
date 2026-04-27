# CHANGELOG

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
