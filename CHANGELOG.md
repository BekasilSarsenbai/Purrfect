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

### Contract Notes

- Current codebase includes all Sprint 1 mandatory baseline requirements and extended operational endpoints for defense depth.
- Additional endpoints not present in the original blueprint were intentionally added for observability, security operations, and moderation workflows.
