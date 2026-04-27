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
- `POST /auth/logout-all` -> Implemented (`src/routes/auth.routes.js`)

## Users

- `GET /users/me` -> Implemented (`src/routes/users.routes.js`)
- `POST /users/me/change-password` -> Implemented (`src/routes/users.routes.js`)
- `GET /users/me/sessions` -> Implemented (`src/routes/users.routes.js`)
- `DELETE /users/me/sessions/{sessionId}` -> Implemented (`src/routes/users.routes.js`)

## Listings

- `GET /listings` -> Implemented (partial) (`src/routes/listings.routes.js`, sort options not fully aligned with all documented enum values)
- `POST /listings` -> Implemented (`src/routes/listings.routes.js`)
- `GET /listings/{listingId}` -> Implemented (`src/routes/listings.routes.js`)
- `PATCH /listings/{listingId}` -> Implemented (`src/routes/listings.routes.js`)
- `DELETE /listings/{listingId}` -> Implemented (`src/routes/listings.routes.js`)
- `POST /listings/{listingId}/submit-review` -> Implemented (`src/routes/listings.routes.js`)
- `POST /listings/{listingId}/media` -> Implemented (`src/routes/listing-assets.routes.js`)
- `GET /listings/{listingId}/media` -> Implemented (`src/routes/listing-assets.routes.js`)
- `POST /listings/{listingId}/documents` -> Implemented (`src/routes/listing-assets.routes.js`)
- `GET /listings/{listingId}/documents` -> Implemented (`src/routes/listing-assets.routes.js`)
- `POST /listings/{listingId}/documents/{documentId}/verify` -> Implemented (`src/routes/listing-assets.routes.js`)

## Orders

- `POST /orders` -> Implemented (`src/routes/orders.routes.js`)
- `GET /orders` -> Implemented (`src/routes/orders.routes.js`)
- `GET /orders/{orderId}` -> Implemented (`src/routes/orders.routes.js`)
- `POST /orders/{orderId}/handover-confirm` -> Implemented (`src/routes/orders.routes.js`)
- `POST /orders/{orderId}/cancel` -> Implemented (`src/routes/orders.routes.js`)
- `GET /orders/{orderId}/transactions` -> Implemented (`src/routes/order-insights.routes.js`)
- `GET /orders/{orderId}/payouts` -> Implemented (`src/routes/order-insights.routes.js`)
- `GET /orders/{orderId}/timeline` -> Implemented (`src/routes/order-insights.routes.js`)

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
- `POST /disputes/{disputeId}/reopen` -> Implemented (`src/routes/disputes.routes.js`)

## Moderation

- `GET /moderation/disputes` -> Implemented (partial) (`src/routes/moderation.routes.js`, `sort` query behavior is simplified)
- `POST /moderation/disputes/{disputeId}/resolve` -> Implemented (`src/routes/moderation.routes.js`)
- `GET /moderation/cases` -> Implemented (`src/routes/moderation.routes.js`)
- `GET /moderation/cases/{caseId}` -> Implemented (`src/routes/moderation.routes.js`)
- `GET /moderation/listings` -> Implemented (`src/routes/moderation-listings.routes.js`)
- `POST /moderation/listings/{listingId}/approve` -> Implemented (`src/routes/moderation-listings.routes.js`)
- `POST /moderation/listings/{listingId}/reject` -> Implemented (`src/routes/moderation-listings.routes.js`)
- `POST /moderation/listings/{listingId}/risk-flag` -> Implemented (`src/routes/moderation-listings.routes.js`)
- `GET /moderation/listings/{listingId}/risk-signals` -> Implemented (`src/routes/moderation-listings.routes.js`)

## Admin

- `PATCH /admin/users/{userId}/role` -> Implemented (`src/routes/admin.routes.js`)
- `PATCH /admin/users/{userId}/status` -> Implemented (`src/routes/admin.routes.js`)
- `GET /admin/audit-logs` -> Implemented (`src/routes/admin.routes.js`)
- `GET /admin/dashboard-kpis` -> Implemented (`src/routes/admin.routes.js`)

## Notes

- All implemented routes are protected where required through `requireAuth` and `requireRoles`.
- Contract deviations are documented in `CHANGELOG.md`; this matrix tracks endpoint-level status only.
