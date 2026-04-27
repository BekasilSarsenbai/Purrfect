# CHANGELOG

## 2026-04-27

- Initialized backend project with Express + Prisma + Docker.
- Added authentication baseline endpoints with JWT access/refresh and RBAC middleware.
- Added admin role update endpoint.
- Added initial order transaction flow (`create order`, `handover confirm`) with Prisma transactions.
- Mounted Swagger UI at `/docs` from `openapi.yaml`.

### Contract Notes

- Current codebase implements the Sprint 1 subset of `openapi.yaml`.
- Remaining endpoints from the full contract will be delivered in the next iterations.
