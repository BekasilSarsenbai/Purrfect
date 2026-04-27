# OpenAPI Implementation Matrix

Status key:
- `Implemented`: route exists and is wired in `src/app.js`.
- `Implemented (partial)`: route exists, but one or more query/behavior details differ from `openapi.yaml`.
- `Not implemented`: route is not yet present in server code.

## Auth

- `POST /auth/register` -> Implemented (`src/routes/auth.routes.js`)
- `POST /auth/login` -> Implemented (`src/routes/auth.routes.js`)
- `POST /auth/refresh` -> Implemented (`src/routes/auth.routes.js`)
- `POST /auth/logout` -> Implemented (`src/routes/auth.routes.js`)

## Users

- `GET /users/me` -> Implemented (`src/routes/users.routes.js`)

## Listings

- `GET /listings` -> Implemented (partial) (`src/routes/listings.routes.js`, sort options not fully aligned with all documented enum values)
- `POST /listings` -> Implemented (`src/routes/listings.routes.js`)
- `GET /listings/{listingId}` -> Implemented (`src/routes/listings.routes.js`)
- `PATCH /listings/{listingId}` -> Implemented (`src/routes/listings.routes.js`)
- `DELETE /listings/{listingId}` -> Implemented (`src/routes/listings.routes.js`)
- `POST /listings/{listingId}/submit-review` -> Implemented (`src/routes/listings.routes.js`)

## Orders

- `POST /orders` -> Implemented (`src/routes/orders.routes.js`)
- `GET /orders` -> Implemented (`src/routes/orders.routes.js`)
- `GET /orders/{orderId}` -> Implemented (`src/routes/orders.routes.js`)
- `POST /orders/{orderId}/handover-confirm` -> Implemented (`src/routes/orders.routes.js`)
- `POST /orders/{orderId}/cancel` -> Implemented (`src/routes/orders.routes.js`)

## Inspections

- `POST /orders/{orderId}/inspection` -> Implemented (`src/routes/inspections.routes.js`)
- `GET /orders/{orderId}/inspection` -> Implemented (`src/routes/inspections.routes.js`)
- `POST /orders/{orderId}/inspection/approve` -> Implemented (`src/routes/inspections.routes.js`)

## Disputes

- `POST /disputes` -> Implemented (`src/routes/disputes.routes.js`)
- `GET /disputes` -> Implemented (`src/routes/disputes.routes.js`)
- `GET /disputes/{disputeId}` -> Implemented (`src/routes/disputes.routes.js`)
- `POST /disputes/{disputeId}/evidence` -> Implemented (`src/routes/disputes.routes.js`)
- `GET /disputes/{disputeId}/evidence` -> Implemented (`src/routes/disputes.routes.js`)

## Moderation

- `GET /moderation/disputes` -> Implemented (partial) (`src/routes/moderation.routes.js`, `sort` query behavior is simplified)
- `POST /moderation/disputes/{disputeId}/resolve` -> Implemented (`src/routes/moderation.routes.js`)

## Admin

- `PATCH /admin/users/{userId}/role` -> Implemented (`src/routes/admin.routes.js`)
- `PATCH /admin/users/{userId}/status` -> Implemented (`src/routes/admin.routes.js`)
- `GET /admin/audit-logs` -> Implemented (`src/routes/admin.routes.js`)

## Notes

- All implemented routes are protected where required through `requireAuth` and `requireRoles`.
- Contract deviations are documented in `CHANGELOG.md`; this matrix tracks endpoint-level status only.
