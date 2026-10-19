# Poplar v3 — API Reference

Complete reference of the REST API served by the Express backend (`backend/src/routes`, `validations`, `controllers`). Companion documents: [README](../README.md) · [01-overview.md](01-overview.md) · [02-features.md](02-features.md) · [03-data-model.md](03-data-model.md).

## Contents

1. [Conventions](#1-conventions) — base path, authentication, CSRF, responses, pagination, dates, errors, idempotency
2. [Endpoint summary](#2-endpoint-summary)
3. [Health and auth](#3-health-and-auth)
4. [Users](#4-users)
5. [Models, lookup and QR](#5-models-lookup-and-qr)
6. [Stock operations](#6-stock-operations)
7. [Series and movements](#7-series-and-movements)
8. [Invoices and returns](#8-invoices-and-returns)
9. [Reports and settings](#9-reports-and-settings)
10. [Finance](#10-finance)
11. [Suppliers](#11-suppliers)
12. [Employees and payroll](#12-employees-and-payroll)
13. [Error codes](#13-error-codes)
14. [curl examples](#14-curl-examples)

---

## 1. Conventions

**Base path** `/api`. The server speaks JSON only (request body limit **100 kb**). All messages in error bodies are Arabic; `code` values are stable and meant for programs.

### 1.1 Authentication, CSRF and permissions

- **Server-side sessions.** `POST /auth/login` sets the cookie `poplar_sid` (`HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure` in production). Send it back with every request (`curl -b jar.txt`).
- Every route except `GET /health` and `POST /auth/login` requires a valid session (**401** `UNAUTHENTICATED`) and then a permission (**403** `FORBIDDEN`). Order of checks: authenticate → CSRF → permission → field guards → validation → controller.
- **CSRF:** every request that is not `GET`/`HEAD`/`OPTIONS` must send the header `x-csrf-token: <csrfToken>` (returned by login and `GET /auth/me`), otherwise **403** `CSRF_INVALID`.
- Passwords: at least 10 characters, letters and digits, not containing the username. Unknown user, wrong password and disabled account all answer the same 401 `INVALID_CREDENTIALS`.
- Login rate limits count failed attempts only: per (IP + account) `LOGIN_MAX_ATTEMPTS` per 15 minutes and per IP 4× that → **429** `LOGIN_RATE_LIMITED`. All of `/api` is limited per IP (`RATE_LIMIT_PER_MINUTE`) → **429** `RATE_LIMITED`.
- Permission names and which are admin-only: see [01-overview.md §4.5](01-overview.md#45-authorization-rbac). The `admin` role has all permissions.
- **Response filtering:** for any user without `costs.view` (every employee) the server removes these keys at any depth: `costPrice, costUsd, unitCostUsd, profitUsd, reversedProfitUsd, reversedProfit, writeOffUsd, fxDiffUsd, unitPriceUsd, totalUsd, refundUsd, refundUsdToday, costValueUsd, sellValueUsd, flag, flags, belowCost`.

### 1.2 Responses

Success replies are the bare JSON value (no envelope), created through `res.success(data, status)`. Typical statuses: **200** read/update, **201** created/posted. Postings that accept an idempotency key answer **201** the first time and **200** with `"duplicate": true` for a repeat.

### 1.3 Pagination

Paginated list endpoints accept `page` (≥ 1, default 1) and `limit` (1–100; the default is noted per endpoint) and return

```json
{ "items": [ ... ], "page": 1, "limit": 25, "total": 158, "pages": 7 }
```

Not paginated (arrays, capped): `GET /invoices` and `GET /returns` return up to 300 rows, newest first.

### 1.4 Dates and money in requests

- `from`/`to`/`date` values are ISO-8601 strings (anything `Date.parse` accepts, e.g. `2026-10-01T00:00:00.000Z`). Ranges are **`from` inclusive, `to` exclusive**. On the list endpoints for invoices, returns, movements and series the range applies only when **both** `from` and `to` are present.
- `tz` (IANA name, e.g. `Asia/Damascus`) controls the day boundary for daily aggregates; invalid names fall back to `UTC`.
- Money amounts in request bodies are numbers in the **major unit of the stated currency**: USD with at most 2 decimals, SYP whole pounds (`INVALID_AMOUNT_PRECISION` otherwise). Ledger responses return major-unit numbers too (`amount`), with integer minor units kept internally.
- `currency` is `"USD"` or `"SYP"`; a **currency is never converted or summed** with the other by any endpoint.

### 1.5 Errors

```json
{ "message": "الرتل فارغ: أضف مقاساً واحداً على الأقل بكمية 1 أو 2.", "code": "INVALID_SERIES", "requestId": "3f0d…" }
```

- `message` (Arabic), `code` (stable), `requestId` (also in the `X-Request-Id` header and the server log).
- Validation errors add `errors: [{ field, message }]` (`field` is a dotted path such as `series.0.sizes.1.qty`) with code `VALIDATION_ERROR`; the `message` carries the first problem.
- Some application errors add `details` (for example `INVALID_SERIES` lists all composition problems; `DUPLICATE_SUPPLIER` returns `{ id }` of the existing supplier).
- Unknown JSON fields are rejected (every body schema is `.strict()`); ids are checked as 24-hex ObjectIds; strings are trimmed and length-capped; numbers are range-checked.
- Unexpected errors never leak internals: `500 INTERNAL_ERROR` with a generic message; database outage → `503 DB_UNAVAILABLE`.

Generic errors raised by the platform:

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | zod or Mongoose validation failed (`errors[]`) |
| 400 | `INVALID_ID` | malformed id (cast error) |
| 400 | `INVALID_JSON` | body is not valid JSON |
| 401 | `UNAUTHENTICATED` | no/expired/revoked session |
| 401 | `INVALID_CREDENTIALS` | bad login or wrong current password |
| 403 | `FORBIDDEN` | missing permission |
| 403 | `FORBIDDEN_FIELD` | field the caller may not send (see 6.1) |
| 403 | `CSRF_INVALID` | CSRF header missing or wrong |
| 404 | `NOT_FOUND` | unknown `/api` path |
| 409 | `MODEL_NUMBER_TAKEN`, `BARCODE_TAKEN`, `SHIPMENT_DUPLICATE`, `USERNAME_TAKEN`, `NUMBER_TAKEN`, `DUPLICATE` | unique-index collision (E11000), mapped by key |
| 413 | `PAYLOAD_TOO_LARGE` | body over 100 kb |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | login not sent as JSON |
| 429 | `RATE_LIMITED`, `LOGIN_RATE_LIMITED` | limiters |
| 500 | `INTERNAL_ERROR` | unexpected |
| 503 | `DB_UNAVAILABLE` | MongoDB not reachable |

Domain error codes are listed in [§12](#12-error-codes).

### 1.6 Idempotency

Postings that must never happen twice carry an **`idempotencyKey`** in the body (string, 8–100 characters; a UUID works): shipments (`POST /stock/receive`), manual cash movements, expenses, and every supplier posting (invoices, payments, advances, adjustments, manual allocations, settlements, supplier returns). The first success → **201**; a repeat with the same key → **200** with `"duplicate": true` and the original result; nothing is posted twice, even for concurrent requests. A key reused for a different operation or supplier → 409 `IDEMPOTENCY_MISMATCH`; an identical request still being processed → 409 `SHIPMENT_IN_PROGRESS` / `SETTLEMENT_IN_PROGRESS` / `RETURN_IN_PROGRESS`. Cash movements caused by sales, cancellations, refunds and supplier entries use deterministic internal keys, so retries cannot duplicate them.

Invoice creation (`POST /invoices`) and returns (`POST /returns`) have **no** idempotency key; the cashier guards double submission in the UI and returns are protected by atomic returnable-quantity reservation.

---

## 2. Endpoint summary

| Method | Path | Permission |
|---|---|---|
| GET | `/health` | public |
| POST | `/auth/login` | public |
| GET | `/auth/me` | session |
| POST | `/auth/logout` | session |
| POST | `/auth/change-password` | session |
| GET, POST | `/users` | `users.manage` |
| PATCH | `/users/:id` | `users.manage` |
| POST | `/users/:id/reset-password` | `users.manage` |
| GET | `/models` | `models.read` |
| GET | `/models/facets` | `models.read` |
| GET | `/models/next-number` | `models.manage` |
| POST | `/models` | `models.manage` |
| GET | `/models/:modelNumber` | `models.read` |
| PUT | `/models/:modelNumber` | `models.manage` |
| DELETE | `/models/:modelNumber` (archive) | `models.manage` |
| POST | `/models/:modelNumber/restore` | `models.manage` |
| GET | `/models/:modelNumber/qr` | `models.read` |
| GET | `/lookup` | `models.read` |
| POST | `/qr/resolve` | `models.read` |
| POST | `/stock/receive` | `stock.receive` |
| POST | `/stock/transfer` | `stock.transfer` |
| POST | `/stock/damage` | `stock.damage` |
| POST | `/stock/adjust` | `stock.adjust` |
| GET | `/series`, `/series/:seriesNo` | `series.read` |
| GET | `/movements` | `movements.read` |
| POST | `/invoices` | `invoices.create` |
| GET | `/invoices`, `/invoices/:id` | `invoices.read` |
| POST | `/invoices/:id/cancel` | `invoices.cancel` |
| POST | `/returns` | `returns.create` |
| GET | `/returns` | `returns.read` |
| GET | `/reports/dashboard` | `dashboard.view` |
| GET | `/reports/inventory` | `reports.view` |
| GET | `/reports/summary` (deprecated) | `reports.view` |
| GET | `/settings` | `settings.read` |
| PUT | `/settings` | `settings.manage` |
| * | `/finance/*` (7 endpoints) | `finance.manage` |
| * | `/suppliers/*` (24 endpoints) | `suppliers.manage` |
| GET, POST | `/employees` | `employees.read` / `employees.manage` |
| GET, PATCH | `/employees/:id` | `employees.read` / `employees.manage` |
| GET | `/employees/:id/payroll-summary` | `payroll.read` |
| GET | `/employees/:id/account`, `/employees/:id/payroll-periods`, `/employees/:id/ledger` | `payroll.read` |
| POST | `/employees/:id/adjustments` | `payroll.manage` |
| POST | `/employees/:id/settle-advances` | `advances.manage` |
| POST | `/employees/:id/close-period` | `payroll.approve` |
| POST | `/payroll-periods` | `payroll.manage` |
| GET | `/payroll-periods/:id`, `/payroll-periods/:id/summary` | `payroll.read` |
| POST | `/payroll-periods/:id/adjustments`, `…/adjustments/:entryId/reverse` | `payroll.manage` |
| POST | `/payroll-periods/:id/approve`, `/payroll-periods/:id/close` | `payroll.approve` |
| POST | `/payroll-periods/:id/payments`, `…/payments/:entryId/reverse` | `payroll.pay` |
| GET | `/employee-advances`, `/employee-advances/:id` | `advances.read` |
| POST | `/employee-advances/issue` (record + disburse in one step), `/employee-advances`, `…/:id/disburse`, `…/:id/settlements`, `…/:id/reassign` | `advances.manage` |
| POST | `/employee-advances/:id/reversals`, `…/:id/settlements/:entryId/reverse` | `advances.reverse` |

---

## 3. Health and auth

### `GET /api/health`
Public. Not under CSRF. Returns `{ "ok": true, "db": "up" | "down" }`.

### `POST /api/auth/login`
Public; body must be `Content-Type: application/json`. Rate limited (failed attempts).

| Body | Type | Rules |
|---|---|---|
| `identifier` | string | required, 1–64 (username, case-insensitive) |
| `password` | string | required, 1–128 |

Response **200**
```json
{ "user": { "id": "…", "name": "المالك", "username": "admin", "role": "admin", "active": true, "permissions": ["models.read", "…"] },
  "csrfToken": "…" }
```
Sets `poplar_sid`. Always issues a new session and ends any session named by an old cookie. Errors: 401 `INVALID_CREDENTIALS`, 415, 429 `LOGIN_RATE_LIMITED`, 400 `VALIDATION_ERROR`.

### `GET /api/auth/me`
Session required. Returns `{ user: { id, name, username, role, permissions[] }, csrfToken }` — used to restore the session after a refresh.

### `POST /api/auth/logout`
Session + CSRF. Deletes the session and clears the cookie. Returns `{ "ok": true }`.

### `POST /api/auth/change-password`
Session + CSRF. Body `{ currentPassword, newPassword }` (both required, ≤ 128). Verifies the current password, applies the policy (`WEAK_PASSWORD` 400), bumps `tokenVersion`, deletes **all** sessions of the user and returns a fresh session cookie plus `{ user, csrfToken }`. Errors: 401 `INVALID_CREDENTIALS` (wrong current password).

---

## 4. Users

All require `users.manage` (owner). Owner accounts are protected: they cannot be modified here.

### `GET /api/users`
Array of `{ id, name, username, role, active, permissions[], createdAt, lastLoginAt }` ordered by creation.

### `POST /api/users`
Body (strict): `name` (1–80), `username` (3–64; lowercased; `[a-z0-9._@+-]`), `password` (≤ 128; policy checked), `permissions?` (array of **grantable** permission names; defaults to the employee defaults). The role is always `employee`; a `role` field is rejected. Returns the user (**201**). Errors: 409 `USERNAME_TAKEN`, 400 `WEAK_PASSWORD`.

### `PATCH /api/users/:id`
Body (strict, all optional): `name`, `permissions[]` (grantable only), `active` (boolean). Changing permissions or `active` ends the employee's sessions immediately. Errors: 404 `USER_NOT_FOUND`, 403 `ADMIN_ACCOUNT_PROTECTED`.

### `POST /api/users/:id/reset-password`
Body `{ password }`. Ends the employee's sessions. Returns `{ "ok": true }`. Errors as above plus `WEAK_PASSWORD`.

---

## 5. Models, lookup and QR

A *model object* returned by these endpoints (after the `model` presenter; employees do not receive `costPrice`):

```json
{
  "id": "…", "modelNumber": "FAF-001", "name": "بنطال بوت كات", "brand": "FAF", "origin": "local",
  "type": "بنطال", "cut": "بوت كات", "season": "صيف 2026", "notes": "", "costPrice": 22, "sellPrice": 45,
  "active": true, "createdAt": "…", "updatedAt": "…",
  "sizes": [ { "id": "…", "size": "M", "barcode": "6291001…", "shopQty": 3, "warehouseQty": 2, "totalQty": 5,
               "availability": "both", "canTransfer": false, "needsFactoryRestock": false } ],
  "totals": { "shop": 7, "warehouse": 9, "combined": 16 },
  "availableSizes": ["S","M"], "outOfStockSizes": [], "transferableSizes": [], "restockSizes": []
}
```

`availability` ∈ `both`, `store_only`, `warehouse_only`, `out_of_stock`. `canTransfer` = shop 0 and warehouse > 0; `needsFactoryRestock` = both 0. Quantities are summed from series.

### `GET /api/models` — `models.read`
Query: `q` (≤ 100), `brand`, `type`, `cut`, `origin` (`foreign`|`local`), `status` (`out` = has a size with zero in both places, `transfer` = has a size to move from warehouse), `includeInactive` (`true`), `sort` (`name`|`modelNumber`|`updatedAt`|`brand`), `dir` (`asc`|`desc`), `page`, `limit` (default 20, max 100). Default order: most recently updated first.
Response: paginated list of model objects. **With `q`** the tiered search runs (exact model number → model-number prefix → name/brand/type words from their start → mid-word fallback): results are capped at `limit`, there is only one page (`page: 1`, `total` = number returned) and the response adds `query` (normalised) and `exact` (true when the first hit is an exact model-number match); each item carries `matchType` (`model_number_exact`, `model_number_prefix`, `name`, `partial`).

### `GET /api/models/facets` — `models.read`
`{ "brands": [...], "types": [...], "cuts": [...] }` — distinct non-empty values among active models, sorted.

### `GET /api/models/next-number?brand=` — `models.manage`
`{ "modelNumber": "FAF-003" }` — suggestion only; the counter is not consumed.

### `POST /api/models` — `models.manage`
Body (strict):

| Field | Rules |
|---|---|
| `modelNumber?` | blank/omitted = generated per brand; otherwise `^[A-Z0-9][A-Z0-9._-]{1,31}$`, no spaces, normalised to upper-case |
| `name` (≤120), `brand` (≤60), `type` (≤60) | required |
| `origin` | `foreign` \| `local`, required |
| `cut`, `season` (≤60), `notes` (≤300) | optional, default `""` |
| `costPrice`, `sellPrice` | numbers 0–1,000,000,000 (USD), required |
| `sizes` | 1–30 items `{ size, barcode? }`; `size` matches `^[A-Z0-9][A-Z0-9./-]{0,9}$` (normalised); barcode ≤ 64, empty = internal `POP-000001` |
| `openingSeries?` | up to 20 `{ location, sizes[{ size, qty: 1|2 }] }` — stored as received series with `receive` movements (ref `OPENING`); each size must be one of `sizes` (`SIZE_NOT_IN_MODEL`) |

Returns the model object (**201**). Errors: 409 `MODEL_NUMBER_TAKEN`, `BARCODE_TAKEN`; 400 `DUPLICATE_SIZE`, `INVALID_MODEL_NUMBER`, `INVALID_SERIES`, `SIZE_NOT_IN_MODEL`.

### `GET /api/models/:modelNumber` — `models.read`
One model object. 404 `MODEL_NOT_FOUND`. (Static routes are declared before this parameter route.)

### `PUT /api/models/:modelNumber` — `models.manage`
Body (strict, all optional): `name, brand, origin, type, cut, season, notes, costPrice, sellPrice, addSizes[{size, barcode?}] (≤30), removeSizes[size] (≤30)`. The model number cannot change. Errors: 409 `SIZE_EXISTS`, `SIZE_HAS_STOCK`, `BARCODE_TAKEN`; 400 `LAST_SIZE`; 404 `SIZE_NOT_FOUND`.

### `DELETE /api/models/:modelNumber` — `models.manage`
**Archives** (sets `active=false`); not a hard delete. Returns the model. `POST /api/models/:modelNumber/restore` un-archives.

### `GET /api/models/:modelNumber/qr` — `models.read`
`{ "modelNumber": "FAF-001", "name": "…", "payload": "PLP1:FAF-001", "svg": "<svg …>" }` — printable SVG QR (error correction M).

### `GET /api/lookup?code=` — `models.read`
One resolver for the scanner, the search bar and the cashier. `code` (1–200). Interpretation order: QR payload (`PLP<version>:…`) → size barcode of an active model → model number.
Response: `{ "kind": "model", "model": {…} }` or `{ "kind": "size", "model": {…}, "size": {…} }`.
Errors: 400 `EMPTY_CODE`, `INVALID_QR`, `OBSOLETE_QR`; 404 `CODE_NOT_FOUND`, `QR_NOT_FOUND`; 409 `QR_OBSOLETE` (archived model).

### `POST /api/qr/resolve` — `models.read`
Body `{ payload }` (1–200). Same as above but accepts only QR payloads; returns `{ kind: "model", model }`.

---

## 6. Stock operations

All return `{ "model": <model object> }` (receive adds more).

### 6.1 `POST /api/stock/receive` — `stock.receive`

```json
{
  "modelNumber": "FAF-001",
  "series": [ { "sizes": [ { "size": "M", "qty": 2 }, { "size": "L", "qty": 1 } ] } ],
  "location": "warehouse",
  "unitCostUsd": 22,
  "idempotencyKey": "b6a1f9d2-6d53-4f0e-9a3b-1a2b3c4d5e6f",
  "note": "Factory invoice 1203",
  "supplierId": "…", "consignment": true,
  "consignmentPrice": { "amount": 55, "currency": "USD", "rate": 15000 },
  "purchase": {
    "invoiceNo": "AML-77", "invoiceDate": "2026-10-17T00:00:00Z", "dueDate": "2026-11-17T00:00:00Z",
    "currency": "USD", "amount": 1000, "rate": 15000, "terms": "30 days",
    "payment": { "cashAmount": 400, "advances": [ { "entryId": "…", "amount": 100 } ], "date": "2026-10-17T00:00:00Z" }
  }
}
```

| Field | Rules |
|---|---|
| `modelNumber` | existing, **active** model |
| `series` | 1–20 series; each `{ sizes[{ size, qty }] }`, non-empty, **every qty exactly 1 or 2**, no repeated size inside a series (`INVALID_SERIES`) |
| `location` | `shop` \| `warehouse` (default `warehouse`) |
| `unitCostUsd?` | number ≥ 0. **Needs `costs.manage`** (else 403 `FORBIDDEN_FIELD`). When given, the model cost becomes the weighted average |
| `idempotencyKey` | required, 8–100 chars |
| `note?` | ≤ 200 |
| `supplierId?`, `consignment?`, `consignmentPrice?` | **Need `suppliers.manage`** (else 403 `FORBIDDEN_FIELD`). `consignment: true` requires `supplierId` (`SUPPLIER_REQUIRED`); `consignmentPrice` only with consignment (`PRICE_NOT_CONSIGNMENT`); `amount` > 0 in its currency, `currency` default `USD`, `rate` optional (documentation). The supplier must be active (`SUPPLIER_INACTIVE`). **No liability and no cash movement is created.** |

| `purchase?` | **Needs `suppliers.manage`**. Ordinary purchase only: requires `supplierId` and not `consignment` (400 otherwise). Creates, **inside the same atomic operation as the stock receipt**, the supplier invoice (linked to the shipment ref and series) and optionally a cash `payment` (`payment.cashAmount`, in the invoice currency, exactly one cash movement from that currency's account, allocated directly to the invoice) and allocations of existing same-currency credits (`payment.advances[]`, no cash movement). `cashAmount + Σ advances` must not exceed `amount` (409 `INVOICE_OVERPAID`); an advance larger than its available balance → 409 `ALLOCATION_EXCEEDS_CREDIT`; another currency → 409 `CROSS_CURRENCY_CONFIRM_REQUIRED` (allocate from the supplier page with an explicit rate); a repeated invoice number for the supplier → 409 `DUPLICATE_INVOICE`. Any failure rolls back the whole receipt. Ledger idempotency keys are derived from the shipment key (`<key>:inv`, `:pay`, `:adv<n>`). The response gains `purchase: { invoice: { id, invoiceNo, currency, amount, ref }, paymentRef, cashPaid, advanceApplied, outstanding, payStatus: unpaid|partial|paid, allocationRefs, shipmentRef }`. |

Response **201** (first time) / **200** (`duplicate: true`, with a short `purchase` summary if one was created):
```json
{ "model": { … }, "duplicate": false, "series": [ { "id": "…", "seriesNo": "SER-000041", "modelNumber": "FAF-001", "location": "warehouse", "kind": "received", "status": "active", "sizes": [{ "size": "M", "initialQty": 2, "qty": 2 }], "totalPieces": 3, "sizeSummary": "L: 1, M: 2", "receivedAt": "…", "shipmentRef": "SHP-1A2B3C", "ownership": "owned", … } ] }
```
New size names in `series` are added to the model automatically. Errors: 404 `MODEL_NOT_FOUND`; 409 `MODEL_ARCHIVED`, `IDEMPOTENCY_MISMATCH`, `SHIPMENT_IN_PROGRESS`; 404 `SUPPLIER_NOT_FOUND`.

### 6.2 `POST /api/stock/transfer` — `stock.transfer`
Body `{ modelNumber, items: [{ size, qty }] (1–30, qty ≥ 1 integer), from, to, note? }`. `from` ≠ `to` (`SAME_LOCATION`). FIFO from the source; the moved part becomes/merges into a derived series at the destination. Errors: 404 `SIZE_NOT_FOUND`; 409 `INSUFFICIENT_STOCK`, `MODEL_ARCHIVED`. Nothing changes if any line fails.

### 6.3 `POST /api/stock/damage` — `stock.damage`
Body `{ modelNumber, size, qty (≥1), location, reason (required, ≤200) }`. FIFO removal, movement `damaged`.

### 6.4 `POST /api/stock/adjust` — `stock.adjust`
Body `{ modelNumber, size, location, newQty (integer ≥ 0), reason (required, ≤200) }`. Sets the counted quantity at that location. Equal quantity → 400 `NO_DIFFERENCE`. A decrease is FIFO; an increase goes to the balance series.

---

## 7. Series and movements

### `GET /api/series` — `series.read`
Query: `q` (series number prefix, model number prefix, or name), `location`, `status` (`active`|`depleted`), `ownership` (`owned`|`consignment`), `from`/`to` (received date, both required to apply), `sort` (`receivedAt` default | `createdAt` | `seriesNo` | `modelNumber`), `dir` (default `desc`), `page`, `limit` (default 25). Empty `balance` series are hidden.
Items: `{ id, seriesNo, modelId, modelNumber, name, type, cut, location, kind, status, originSeries, sizes[{size, initialQty, qty}], totalPieces, sizeSummary, receivedAt, createdAt, shipmentRef, ownership }`. Supplier identity and agreed prices are **not** part of this operational response.

### `GET /api/series/:seriesNo` — `series.read`
`seriesNo` like `SER-000123` (case-insensitive). The item above plus `origin: { seriesNo, location } | null`, `derived: [{ seriesNo, location }]`, and `movements` (up to 100, newest first: `{ id, type, size, qty, from, to, ref, reason, createdAt, seriesQty }` where `seriesQty` is the quantity that touched this series). 404 `SERIES_NOT_FOUND`.

### `GET /api/movements` — `movements.read`
Query: `q` (model number prefix, name, or reference prefix such as `INV-12`), `type` (one of `sale, receive, transfer, return, return_damaged, damaged, adjust, cancel, supplier_return`), `location` (from or to), `size`, `series` (`SER-…`), `from`/`to` (both), `sort` (`createdAt` default | `type` | `modelNumber` | `qty`), `dir` (default `desc`), `page`, `limit` (default 25).
Items are the movement documents: `{ _id, type, model, modelNumber, name, brand, size, qty, delta, from, to, before{shop,warehouse}, after{…}, costUsd, reason, ref, batchId, allocations[{series, seriesNo, qty, location}], createdAt }` (`costUsd` removed for employees).

---

## 8. Invoices and returns

### `POST /api/invoices` — `invoices.create`
```json
{ "items": [ { "modelId": "…", "sizeId": "…", "qty": 1, "unitPrice": 45 } ], "currency": "USD", "note": "optional" }
```
`items`: 1–100 lines (`modelId`/`sizeId` are the `id` of the model and of its size; `qty` 1–1,000,000; `unitPrice` ≥ 0 in the invoice currency). `currency` `USD` (default) or `SYP`. SYP needs an exchange rate in settings (400 `RATE_REQUIRED`).
Atomically: snapshot lines, FIFO deduction from **shop** stock, sale movements, invoice number, and a cash receipt of `cashDue` in the invoice currency. Response **201** — the invoice document:

```json
{ "_id": "…", "number": 19, "currency": "SYP", "rate": 15000,
  "items": [ { "model": "…", "sizeId": "…", "modelNumber": "FAF-002", "name": "…", "brand": "FAF", "origin": "local", "type": "…", "cut": "…",
               "size": "32", "barcode": "…", "qty": 1, "returnedQty": 0, "allocations": [ { "series": "…", "seriesNo": "SER-000007", "qty": 1 } ],
               "costPrice": 20, "sellPrice": 40, "unitPrice": 560000, "unitPriceUsd": 37.3333, "flag": "normal" } ],
  "itemsCount": 1, "totalPaid": 560000, "creditApplied": 0, "cashDue": 560000,
  "totalUsd": 37.3333, "costUsd": 20, "profitUsd": 17.3333, "status": "completed", "note": "", "createdAt": "…", "updatedAt": "…" }
```
(`unitPriceUsd`, `costPrice`, `flag`, `totalUsd`, `costUsd`, `profitUsd` are removed for employees.) Errors: 400 `EMPTY_INVOICE`, `RATE_REQUIRED`; 404 `MODEL_UNAVAILABLE` (missing/archived model), `SIZE_NOT_FOUND`; 409 `INSUFFICIENT_STOCK` (shop stock; nothing is deducted).

### `GET /api/invoices` — `invoices.read`
Query `from`, `to` (both to filter). Array of invoices, newest first, max 300.

### `GET /api/invoices/:id` — `invoices.read`
One invoice. 404 `INVOICE_NOT_FOUND`.

### `POST /api/invoices/:id/cancel` — `invoices.cancel`
Returns the pieces to their original series, marks the invoice `cancelled`, reverses the cash receipt. Response **200** `{ "invoice": {…}, "notRestocked": 0 }` (`notRestocked` counts lines whose model/size no longer exists). Errors: 404 `INVOICE_NOT_FOUND`; 409 `ALREADY_CANCELLED`, `EXCHANGE_NOT_CANCELLABLE` (the invoice was created by an exchange), `HAS_RETURNS`, `CONFLICT`.

### `POST /api/returns` — `returns.create`
```json
{ "invoiceId": "…", "items": [ { "itemIndex": 0, "qty": 1, "condition": "good" } ],
  "reason": "wrong size", "mode": "cash" }
```
Exchange:
```json
{ "invoiceId": "…", "items": [ { "itemIndex": 0, "qty": 1, "condition": "good" } ], "reason": "swap", "mode": "exchange",
  "newInvoice": { "items": [ { "modelId": "…", "sizeId": "…", "qty": 1, "unitPrice": 35 } ], "currency": "USD" } }
```
| Field | Rules |
|---|---|
| `invoiceId` | existing **completed** invoice |
| `items` | 1–100 `{ itemIndex (≥0), qty (≥1), condition: "good"|"damaged" (default good) }`; `itemIndex` is the position in `invoice.items`, no repeats; `qty` ≤ still-returnable quantity |
| `reason?` | ≤ 200 |
| `mode` | `cash` (default) \| `exchange` |
| `newInvoice` | required for `exchange`; its `currency` **must equal the original invoice currency** |

Cash mode refunds `refundAmount` out of the cash account of the invoice currency. Exchange mode creates the new invoice with the refund as `creditApplied`; only the difference moves cash. Good pieces return to their original series; damaged pieces are written off. Response **201**: `{ "return": {…}, "invoice": <exchange invoice | null>, "notRestocked": 0 }`.
Errors: 400 `EXCHANGE_ITEMS_REQUIRED`, `EXCHANGE_CURRENCY_MISMATCH`, `INVALID_ITEM`, `RATE_REQUIRED`; 404 `INVOICE_NOT_FOUND`; 409 `INVOICE_CANCELLED`, `RETURN_EXCEEDS`, `CONFLICT`.

### `GET /api/returns` — `returns.read`
Query `from`, `to` (both). Array of returns, newest first, max 300 (employees receive no USD accounting fields).

---

## 9. Reports and settings

### `GET /api/reports/dashboard` — `dashboard.view`
```json
{ "totals": { "models": 9, "sizes": 33, "shop": 52, "warehouse": 70, "costValueUsd": 0, "sellValueUsd": 0, "combined": 122 },
  "counts": { "restock": 3, "transfer": 5 },
  "attention": [ { "modelNumber": "FAF-001", "name": "…", "brand": "FAF", "restockSizes": ["XL"], "transferSizes": [ { "size": "M", "warehouseQty": 2 } ] } ],
  "recent": [ /* last 8 stock movements */ ] }
```
`attention` holds at most 200 models. `costValueUsd`/`sellValueUsd` are removed for employees.

### `GET /api/reports/inventory` — `reports.view`
`{ "totals": { "pieces", "shopPieces", "warehousePieces", "costValueUsd", "sellValueUsd" }, "attention": [ … ] }`.

### `GET /api/reports/summary?from&to&tz` — `reports.view` — **deprecated**
Required `from`, `to`; optional `tz`. USD-converted sales summary `{ totals, net, returns, damaged, collected, daily, byBrand, byOrigin, top, flags, belowCost }`. No longer used by the UI; use Finance instead. 400 `RANGE_REQUIRED`.

### `GET /api/settings` — `settings.read`
`{ "key": "main", "usdToSyp": 15000, "lowStockThreshold": 2, … }` — created on first read.

### `PUT /api/settings` — `settings.manage`
Body (strict, optional): `usdToSyp` (0–1,000,000,000, SYP per USD), `lowStockThreshold` (integer 0–1000, deprecated and without effect). Returns the settings.

---

## 10. Finance

All endpoints require `finance.manage` (router-level; employees get 403 on every one, sessions without permission never reach validation). Postings need `idempotencyKey` (8–100 chars); first success **201**, duplicate **200** with `duplicate: true`.

### `GET /api/finance/dashboard?from&to&tz`
`from` and `to` required (ISO), `to` must be after `from` (400 `INVALID_RANGE`; `RANGE_REQUIRED`). Compares against the preceding period of the same length. Response:

```json
{ "period": { "from": "…", "to": "…", "previousFrom": "…", "previousTo": "…" },
  "USD": { …section… }, "SYP": { …section… } }
```
Each section (all numbers in that currency's **major unit**):

| Key | Meaning |
|---|---|
| `currency` | `"USD"` / `"SYP"` |
| `balance`, `balanceAllTime{in,out,movements}` | current cash balance and all-time totals from the cash ledger |
| `cash{in,out,net}` | the period's cash flow (net is not profit) |
| `revenue`, `refunds`, `netRevenue`, `invoices`, `pieces`, `returnsCount` | sales of the period |
| `cogs`, `grossProfit`, `writeOffs`, `writeOffPieces`, `netProfit` | USD: numbers. **SYP: `cogs`, `grossProfit`, `netProfit`, `writeOffs` are `null`** |
| `expenses`, `expensesByCategory[{category, amount}]` | posted, non-reversed expenses |
| `supplierPayments`, `customerRefundsCash` | cash paid to suppliers (net of reversals) / cash refunds to customers |
| `supplierPayable`, `supplierAdvances` | current supplier position in this currency |
| `customerReceivables` | `{ supported: false, reason }` |
| `previous{netRevenue, expenses, cashNet, netProfit}` | previous period (`netProfit` null for SYP) |
| `daily[{day, in, out, revenue}]` | per-day (in `tz`) cash flow and revenue |
| `legacy{invoicesWithoutCash, completedInvoices}` | historical completed invoices with no cash movement (reported, not posted) |
| `unavailable` | explanation string for SYP, `null` for USD |
| `estimate` | SYP only: `{ cogs, grossProfit, netProfit }` separate estimate (not part of any total); `null` for USD |

There is **no combined total** and no conversion between the two sections.

### `GET /api/finance/cash`
Query: `currency?`, `type?` (a cash type), `from?`, `to?` (both to filter by movement `date`), `page`, `limit` (default 25). Paginated `{ id, ref, currency, direction, type, amount, date, note, source{kind, ref}, reverses, reversed, createdBy, createdAt }` ordered newest first. Types: `sale_receipt, sale_cancellation, customer_refund, supplier_payment, supplier_advance, supplier_reversal, expense, expense_reversal, deposit, withdrawal, reversal`.

### `POST /api/finance/cash`
Manual deposit/withdrawal (opening balances, corrections).
Body (strict): `currency`, `direction` (`in`|`out`), `amount` (> 0, ≤ 1e12, precision per currency), `note` (required, ≤ 300), `date?`, `idempotencyKey`. Response `{ "duplicate": false, "movement": {…} }` (201 / 200). Type is `deposit` or `withdrawal`. 400 `INVALID_AMOUNT_PRECISION`.

### `POST /api/finance/cash/:id/reverse`
Body `{ reason }` (required, ≤ 300). Only **manual** movements (409 `CASH_REVERSE_VIA_SOURCE` otherwise; 409 `CASH_ALREADY_REVERSED`; 404 `CASH_NOT_FOUND`). Creates an opposite movement in the same currency. Returns `{ movement }` (**201**).

### `GET /api/finance/expenses`
Query `currency?`, `from?`, `to?` (both), `page`, `limit` (25). Paginated `{ id, ref, currency, amount, category, description, date, status, reversal{at, reason, by}|null, createdBy }`.

### `POST /api/finance/expenses`
Body (strict): `currency`, `amount` (> 0), `category` (required, ≤ 60), `description?` (≤ 300), `date?`, `idempotencyKey`. Deducts the amount from the cash account of its currency in the same atomic unit. Response `{ "duplicate": false, "expense": {…} }` (201 / 200).

### `POST /api/finance/expenses/:id/reverse`
Body `{ reason }`. Restores the cash with an `expense_reversal` movement. Returns `{ expense }` (**201**). Errors: 404 `EXPENSE_NOT_FOUND`, 409 `ALREADY_REVERSED`.

---

## 11. Suppliers

All routes require `suppliers.manage` (owner only, never grantable) — employees get 403 on every one; without a session 401; writes without CSRF 403 `CSRF_INVALID`. Static routes are declared before `/:id`. Bodies are strict.

**Money in these bodies:** `amount` (number > 0, ≤ 1e12), `currency` (`USD` default | `SYP`), `rate?` (> 0, **documentation only**, SYP per USD).
**Account objects:** `positions: { USD: { grossPayable, advance, net }, SYP: { … } }` and `status` ∈ `settled` | `due` | `advance` | `mixed` (never a cross-currency sum).

*Supplier object:* `{ id, name, phone, address, notes, active, createdAt, updatedAt, positions, status, consignmentPieces, consignmentUnpricedPieces, consignmentValueUsd, consignmentValueSyp }`.

### 11.1 Suppliers

| Method / path | Body / query | Response |
|---|---|---|
| `GET /suppliers/summary` | — | `{ activeSuppliers, totals: { USD: {grossPayable, advance, net}, SYP: {…} }, consignmentPieces, consignmentUnpricedPieces, consignmentValueUsd, consignmentValueSyp, attention: [supplier…] (≤10) }` |
| `GET /suppliers` | `q` (name/phone/address), `active` (`true` default \| `false` \| `all`), `account` (`due` includes mixed, `advance` includes mixed, `mixed`, `settled`), `page`, `limit` (20) | paginated supplier objects, ordered by name |
| `POST /suppliers` | `name` (required ≤120), `phone?` (≤40), `address?` (≤300), `notes?` (≤1000), `allowDuplicate?` | supplier (**201**). 409 `DUPLICATE_SUPPLIER` (`details.id`) when the same normalised name + phone exists |
| `GET /suppliers/:id` | — | supplier object. 404 `SUPPLIER_NOT_FOUND` |
| `PATCH /suppliers/:id` | any of `name, phone, address, notes, active, allowDuplicate` | updated supplier (there is **no DELETE**; suppliers are deactivated) |

### 11.2 Ledger and invoices

| Method / path | Body / query | Response |
|---|---|---|
| `GET /suppliers/:id/ledger` | `type`, `currency`, `from`, `to` (both optional here), `page`, `limit` (25) | `{ supplier, summary: { status, positions, byCurrency: { USD:{invoiced, credits, allocatedToInvoices, creditConsumed}, SYP:{…} }, openInvoices, unallocatedCredits }, items, page, limit, total, pages }` newest first; each item: `{ id, ref, type, date, note, currency, amount, rate, valuationUsd, debit, credit, balance, movesCash, crossCurrency{invoiceCurrency, settles, rate}|null, invoice{id, invoiceNo}|null, supplierReturn, settlement, reverses, reversedBy, createdBy, createdAt }` — `balance` is the running balance **in that entry's own currency** |
| `GET /suppliers/:id/invoices` | — | `{ items: [ { id, invoiceNo, kind, invoiceDate, dueDate, currency, amount, rate, terms, note, seriesNos, shipmentRefs, status, overdue, allocated, outstanding, payStatus (paid\|partial\|unpaid), createdAt } ] }` — amounts in the invoice currency |
| `POST /suppliers/:id/invoices` | `invoiceNo` (≤60), `invoiceDate`, `dueDate?`, `amount`, `currency`, `rate?`, `terms?` (≤200), `note?` (≤500), `seriesNos?` (≤60 `SER-…`), `shipmentRefs?`, `idempotencyKey` | `{ duplicate, invoice, entry }` — a liability (`purchase` entry), **no cash**. Errors: 409 `DUPLICATE_INVOICE`, `SUPPLIER_INACTIVE`, `CONSIGNMENT_NOT_PURCHASE`, `SERIES_SUPPLIER_MISMATCH`; 400 `INVALID_DATES`, `USE_SETTLEMENT_WORKFLOW`; 404 `SERIES_NOT_FOUND` |

### 11.3 Payments, advances, adjustments, reversal

| Method / path | Body | Effect and response |
|---|---|---|
| `POST /suppliers/:id/payments` | `amount`, `currency`, `rate?`, `invoiceId?`, `crossCurrency?: { settlesAmount, rate }`, `date?`, `note?`, `idempotencyKey` | **Cash out of the payment currency's account** (`supplier_payment`). With a same-currency `invoiceId` it is allocated to it immediately (`direct`). If the invoice's currency differs, `crossCurrency` is mandatory (else 409 `CROSS_CURRENCY_CONFIRM_REQUIRED`): `settlesAmount` is the amount settled in the invoice currency and `rate` the entered SYP-per-USD rate; inconsistent values → 400 `RATE_AMOUNT_MISMATCH`. Response `{ duplicate, entry }` |
| `POST /suppliers/:id/advances` | `amount`, `currency`, `rate?`, `date?`, `note?`, `idempotencyKey` | Cash out (`supplier_advance`); remains an available credit until allocated |
| `POST /suppliers/:id/adjustments` | `kind` (`credit` \| `adjustment`), `amount`, `currency`, `rate?`, `invoiceId?` (credit only, same currency), `date?`, `note` (**required**, ≤500), `idempotencyKey` | `credit` = credit note (reduces the payable); `adjustment` = debit adjustment (increases it; no invoice link: 400 `INVALID_LINK`). **No cash** either way |
| `POST /suppliers/:id/entries/:entryId/reverse` | `{ reason }` (required, ≤500) | **201** `{ entry }` (the reversal). Releases the credit's allocations, reverses a payment/advance's cash movement, refuses an invoice with live allocations (409 `REVERSE_PAYMENTS_FIRST`), a settlement invoice (409 `REVERSE_VIA_SETTLEMENT`), a reversal (409 `CANNOT_REVERSE_REVERSAL`) or a repeat (409 `ALREADY_REVERSED`); 404 `ENTRY_NOT_FOUND` |

Common errors for postings: 404 `SUPPLIER_NOT_FOUND`; 409 `SUPPLIER_INACTIVE`; 404 `SUPPLIER_INVOICE_NOT_FOUND`; 409 `INVOICE_REVERSED`, `INVOICE_OVERPAID` (record the excess as an advance), `IDEMPOTENCY_MISMATCH`, `CROSS_CURRENCY_NOT_ALLOWED` (credit notes/return credits must match the invoice currency); 400 `INVALID_AMOUNT_PRECISION`, `AMOUNT_TOO_SMALL`.

### 11.4 Allocations

| Method / path | Body | Response |
|---|---|---|
| `GET /suppliers/:id/allocations` | — | `{ credits: [ {…entry, allocated, available} ], items: [ allocation… ] }` (`items` newest first). Allocation: `{ id, ref, kind, source (direct\|manual\|auto\|release), note, currency, amount, creditCurrency, creditAmount, crossCurrency, rate, needsReview, entry{id, ref}, invoice{id, invoiceNo}, releases, released, createdBy, createdAt }` |
| `POST /suppliers/:id/allocations` | `entryId`, `invoiceId`, `amount` (invoice-currency amount), `creditAmount?`, `crossCurrency?` (boolean), `rate?`, `note?`, `idempotencyKey` | `{ duplicate, allocation }`. Same currency: `amount` equals the credit consumed. Cross-currency requires `crossCurrency: true`, `creditAmount` and `rate`, only for `payment`/`advance` credits. **Never creates a cash movement.** Errors: 404 `CREDIT_NOT_FOUND`; 409 `ALLOCATION_EXCEEDS_CREDIT`, `INVOICE_OVERPAID`, `CROSS_CURRENCY_CONFIRM_REQUIRED`, `CROSS_CURRENCY_NOT_ALLOWED`; 400 `RATE_REQUIRED`, `RATE_AMOUNT_MISMATCH`, `AMOUNT_MISMATCH` |
| `POST /suppliers/:id/allocations/auto` | `entryId?` | **201** `{ items: [allocation…], applied: { USD, SYP } }` — oldest credit to oldest open invoice, **same currency only**; writes nothing else |
| `POST /suppliers/:id/allocations/:allocId/release` | `{ reason }` (required) | **201** `{ allocation }` (the `release` record; the original is marked). 404 `ALLOCATION_NOT_FOUND`; 409 `ALREADY_RELEASED` |

### 11.5 Consignment, settlements and returns

| Method / path | Body / query | Response |
|---|---|---|
| `GET /suppliers/:id/consignment` | `q`, `location`, `includeEmpty` | `{ summary: { pieces, unpricedPieces, value: {USD, SYP} }, models: [ { modelId, modelNumber, name, received, remaining, shop, warehouse, sold, settled, unsettled, returned, other, unpriced, value{USD,SYP} } ], series: [ { id, seriesNo, modelNumber, name, location, kind, status, receivedAt, shipmentRef, price{amount,currency,rate}\|null, priceHistory[], remaining, value{amount,currency}\|null, sizes[{size, qty}] } ] }` |
| `POST /suppliers/:id/consignment/prices` | `seriesIds[]` (1–100), `price: { amount, currency, rate? }`, `adjust?` (boolean), `reason` (required ≤300) | **201** `{ updated: ["SER-…"], price }`. First price needs `adjust` absent/false; changing needs `adjust: true`. 409 `CONSIGNMENT_PRICE_EXISTS`, `CONSIGNMENT_PRICE_MISSING`, `NOT_SUPPLIER_CONSIGNMENT`, `CONFLICT` |
| `GET /suppliers/:id/settlements/eligible` | — | `{ items: [ { seriesId, seriesNo, modelNumber, name, location, size, sold, settled, settleable, overSettled, priced, price, estimated } ], summary: { settleablePieces, unpricedSettleablePieces, overSettledLines, estimated: {USD, SYP} } }` |
| `GET /suppliers/:id/settlements` | — | `{ items: [ { id, ref, status, note, currency, items[{seriesNo, modelNumber, name, size, qty, unitAmount, currency, lineAmount}], totalQty, total, invoiceNo, entryRef, reversal, createdBy, createdAt } ] }` |
| `POST /suppliers/:id/settlements` | `items: [{ seriesId, size, qty }]` (1–100), `note?`, `idempotencyKey` | `{ duplicate, settlement, entry }` (201 / 200). Creates the liability in the **agreed price currency** (single currency per settlement). Errors: 409 `NOT_SUPPLIER_CONSIGNMENT`, `CONSIGNMENT_PRICE_MISSING`, `CONSIGNMENT_OVER_SETTLEMENT`, `SETTLEMENT_IN_PROGRESS`, `IDEMPOTENCY_MISMATCH`; 400 `MIXED_CURRENCY_SETTLEMENT`, `AMOUNT_TOO_SMALL`; 404 `SERIES_NOT_FOUND` |
| `POST /suppliers/:id/settlements/:settlementId/reverse` | `{ reason }` | **201** `{ settlement }`. 404 `SETTLEMENT_NOT_FOUND`; 409 `ALREADY_REVERSED`, `REVERSE_PAYMENTS_FIRST`, `SETTLEMENT_INCONSISTENT` |
| `GET /suppliers/:id/returns` | — | `{ items: [ { id, number, ref, supplierId, items[{seriesNo, modelNumber, name, size, qty, location, agreedUnit}], totalQty, value{USD,SYP}, unpricedQty, reason, entryRef, createdAt, createdBy } ] }` |
| `POST /suppliers/:id/returns` | `items: [{ seriesId, size, qty }]` (1–100), `reason` (required ≤300), `idempotencyKey`, `credit?: { amount, currency, rate?, invoiceId?, note? }` | `{ duplicate, return, entry }` (201 / 200). Removes the pieces from stock (movement `supplier_return`); posts a `return_credit` entry only when `credit` is supplied — never cash; with `invoiceId` it must have the same currency and not exceed the remainder (`CROSS_CURRENCY_NOT_ALLOWED`, `INVOICE_OVERPAID`). Errors: 409 `NOT_SUPPLIER_CONSIGNMENT`, `INSUFFICIENT_STOCK`, `RETURN_IN_PROGRESS`, `IDEMPOTENCY_MISMATCH` |

---

## 12. Employees and payroll

All routes are authenticated and CSRF-protected like every other write. Each route needs the narrow permission shown; **all nine payroll permissions are owner-only** (`ADMIN_ONLY`, never grantable to an employee), so employees get 403 on every endpoint and anonymous callers 401. Amounts are numbers in major units in the **record's own currency** (`USD` ≤ 2 decimals, `SYP` whole); the server converts to integer minor units, rejects bad precision (`INVALID_AMOUNT_PRECISION`), and returns every derived total (`net`, `remaining`, …) itself. A `currency` sent with an operation must equal the record's currency (`CURRENCY_MISMATCH`). Posting endpoints need `idempotencyKey` (8–100 chars) which is **bound to the request**: the first call answers **201**; an identical retry (same employee/amount/currency/method/month) **200** with the original result and no second effect; the same key with **different** material parameters answers **409 `IDEMPOTENCY_KEY_REUSED`** and changes nothing. A retry that arrives while the original is still being processed answers **409 `CONCURRENT_UPDATE`** (retry shortly). Ledger entries older than this change carry no fingerprint and keep the previous behaviour.

### 12.0 The employee-centred endpoints (used by the UI)

The UI uses only these for day-to-day work; the low-level period/advance endpoints below are retained for integrations and corrections.

| Method / path | Body / query | Response |
|---|---|---|
| `GET /employees/:id/payroll-summary` | `period?` (`YYYY-MM`; default = oldest open month with a balance, else the current month) | **Authoritative summary** (nothing is created by reading): `{ employee, currency, periodKey, periodExists, status, closed, entitlement, baseSalary, allowances, bonuses, deductions, paid, settlementsApplied, scheduledSettlement, carryForward, remainingBeforeSettlement, remainingPayable, canPay, reason, advances: { outstanding, outstandingCount, pending, scheduledInPeriod, settledInPeriod, items[] }, defaultAdvancePeriodKey, periods[{ id, periodKey, status }], currentKey }`. `reason` ∈ `PERIOD_CLOSED`, `EMPLOYEE_INACTIVE`, `FUTURE_PERIOD`, `BEFORE_HIRE`, `HISTORICAL_SALARY_UNKNOWN`, `INACTIVE_ADVANCE_CARRY`, `NO_SALARY_DUE` when `canPay` is false. Also returned: `indicator`, `nextDueDate`. `remainingPayable = remainingBeforeSettlement − scheduledSettlement` (what the employee will receive). |
| `POST /finance/expenses` (salary) | `category: "رواتب"`, `employeeId` (required), `amount`, `currency` (must equal the employee's), `method?` (`cash` default \| `other`), `periodKey?` (default automatic, never future), `description?`, `date?`, `idempotencyKey` | `{ duplicate, expense, entryId, summary }` (**201**; 200 for a repeat). Needs `finance.manage` **and** `payroll.pay` (403 otherwise). One atomic unit: auto-create/approve the month, settle scheduled advances (partial + carry-forward), conditional payment (`EXCEEDS_REMAINING`, `NO_SALARY_DUE`, `PERIOD_CLOSED`, `FUTURE_PERIOD`, `CURRENCY_MISMATCH`), expense, cash movement (cash only). `employeeId` with another category → 400 `EMPLOYEE_ONLY_FOR_SALARY`; a salary category without it → 400 `EMPLOYEE_REQUIRED`. The category is **normalised** (`isSalaryCategory`: «رواتب», «الرواتب», «راتب», «الراتب», «رواتب الموظفين», `salary`, `salaries`, `payroll`, ignoring spaces/diacritics) and stored canonically as «رواتب»; a variant never silently becomes an ordinary expense. Ordinary categories are unchanged. |
| `POST /finance/expenses/:id/reverse` | `reason` | For a salary expense this reverses the payment ledger entry, the expense and its cash movement together, and requires `payroll.pay` in addition to `finance.manage` (403 otherwise); ordinary expenses need only `finance.manage`. |
| `POST /employee-advances/issue` | `employeeId`, `amount`, `currency?`, `method?` (`cash` default \| `other`), `deductionPeriodKey?` (default = nearest open month) \| `deductionPeriodId?`, `note?`, `date?`, `idempotencyKey` | `{ duplicate, advance, deductionPeriodKey }`: create + disburse. Retry-safe: a failure after the creation leaves a pending advance that the same key completes. |
| `POST /employees/:id/adjustments` | `kind` (`allowance` \| `bonus` \| `deduction`), `amount`, `note`, `periodKey?`, `date?`, `idempotencyKey` | `{ duplicate, entry, period }`; the month is resolved/created automatically; allowed while `draft`, or `approved` with nothing paid or settled. |
| `POST /employees/:id/settle-advances` | `periodKey?` | Applies the scheduled advance deduction now (settle what fits, carry the rest). `{ settledMinor, carriedMinor, summary }`. |
| `POST /employees/:id/close-period` | `periodKey` | Settles scheduled advances, then closes a fully paid month (409 `INVALID_STATE` / `ADVANCES_OPEN`). |

### 12.1 Employees

| Method / path | Body / query | Response |
|---|---|---|
| `GET /employees` | `q` (name or `EMP-…`), `status`, `periodKey?` (`YYYY-MM`; without it each employee gets the default month: oldest open month with a balance, else the current month), `page`, `limit` (20, max 100) | paginated rows built by the **same `buildSummary` as the account** (so list and account always agree): employee + `periodKey`, `period`, `periodStatus`, `indicator`, `due { net, paid, settlementsApplied, scheduledSettlement, remainingBeforeSettlement, remaining }` (**`remaining` = remaining payable after the scheduled advance deduction**), `canPay`, `reason`, `advancesOutstanding` (separate from salary), `advancesOutstandingCount`, `nextDueDate`. Response also has `currentKey` (the server's current month; clients must not guess it). Fixed number of queries per page. |
| `POST /employees` | `name`, `salary`, `currency`, `salaryEffectiveFrom?` (`YYYY-MM`, not in the future: the first month the salary is known to apply; default the month the record was created), `jobTitle?`, `phone?`, `hireDate?`, `status?`, `userId?`, `payDay?` (1–28), `notes?` (strict) | employee (**201**). 409 `USER_ALREADY_LINKED`; 400 `USER_IS_OWNER`. |
| `GET /employees/:id` | | employee |
| `PATCH /employees/:id` | any of the above (`userId: null` unlinks). Changing the salary sets `salaryEffectiveFrom` to the current month unless given; existing periods keep their snapshot. | employee. 409 `CURRENCY_LOCKED` when changing currency after periods/advances exist. |
| `GET /employees/:id/account?period=YYYY-MM` | | `{ employee, periods[], selectedPeriodKey, period \| null, periodAdvances[], outstandingAdvances[], totals }` |
| `GET /employees/:id/payroll-periods` | `status`, `page`, `limit` | paginated periods |
| `GET /employees/:id/ledger` | `type`, `period` (id), `periodKey`, `from`, `to`, `state` (`posted` \| `reversed` \| `reversal`), `page`, `limit` | paginated ledger entries (`state` = `posted` \| `reversed` \| `reversal`) |

*Period object:* `{ id, ref, employeeId, periodKey, start, end, dueDate, currency, baseSalary, allowances, bonuses, deductions, advanceSettlements, net, paid, remaining, status, indicator, approvedAt, approvedBy, closedAt, closedBy }`.

### 12.2 Payroll periods

| Method / path | Body | Response |
|---|---|---|
| `POST /payroll-periods` | `employeeId`, `periodKey`, `currency?`, `idempotencyKey?` | `{ duplicate, period }` (**201**). 409 `PERIOD_EXISTS` (one per employee and month); 409 `EMPLOYEE_INACTIVE`. The salary is snapshotted now. |
| `GET /payroll-periods/:id` | | period |
| `GET /payroll-periods/:id/summary` | | `{ period, ledger[], advances[], settlements[], payments[] }` |
| `POST /payroll-periods/:id/adjustments` | `kind` (`allowance` \| `bonus` \| `deduction`), `amount`, `note`, `date?`, `idempotencyKey` | `{ duplicate, entry, period }`. **Draft only** (409 `INVALID_STATE` after approval); a deduction cannot push `remaining` below 0 (409 `EXCEEDS_REMAINING`). |
| `POST /payroll-periods/:id/adjustments/:entryId/reverse` | `reason` | reversal entry + period (draft only) |
| `POST /payroll-periods/:id/approve` | `{}` | `{ period }`; posts the `salary_entitlement` entry. Only `draft` (409 `INVALID_STATE`). |
| `POST /payroll-periods/:id/payments` | `amount`, `method?` (`cash` default \| `other`), `note?`, `date?`, `currency?`, `idempotencyKey` | `{ duplicate, entry, period, expense }`. **No separate implementation any more:** it calls the same service as Finance → Expenses (`paySalaryExpense`): expense + cash (cash only) + ledger entry + automatic settlement of scheduled advances; never above the remaining payable (409 `EXCEEDS_REMAINING`, `NO_SALARY_DUE`). Legacy contract kept: the period must already be approved (a `draft` period answers 409 `INVALID_STATE`; use `POST /payroll-periods/:id/approve`) and future months are rejected. |
| `POST /payroll-periods/:id/payments/:entryId/reverse` | `reason` | reversal entry + period; reverses the cash movement too. 409 `ALREADY_REVERSED`; 409 `PERIOD_CLOSED`. |
| `POST /payroll-periods/:id/close` | `{}` | `{ period }`. Same operation as `POST /employees/:id/close-period`: **one atomic unit** = approve (if draft) + settle/carry scheduled advances + verify (fully paid, no open advances) + close; any failure rolls everything back (real transaction on a replica set, compensating undo on standalone). 409 `INVALID_STATE` / `ADVANCES_OPEN` leave no side effect. |

### 12.3 Employee advances

| Method / path | Body / query | Response |
|---|---|---|
| `GET /employee-advances` | `employeeId`, `status`, `periodId`, `page`, `limit` | paginated advances |
| `POST /employee-advances` | `employeeId`, `amount`, `deductionPeriodId` (**required**), `currency?`, `note?`, `date?`, `idempotencyKey` | `{ duplicate, advance }` (**201**, status `pending`; **no cash moves**). 400 `PERIOD_EMPLOYEE_MISMATCH` / `CURRENCY_MISMATCH`; 409 `PERIOD_NOT_OPEN` (period paid or closed). |
| `GET /employee-advances/:id` | | `{ advance, ledger[] }` |
| `POST /employee-advances/:id/disburse` | `method?` (`cash` default \| `other`), `note?`, `date?` | `{ duplicate, advance }`. `pending` → `disbursed` by one compare-and-set; `cash` creates exactly one real outflow (`employee_advance`) however many times/concurrent requests; a repeat answers 200. |
| `POST /employee-advances/:id/settlements` | `amount`, `currency?`, `note?`, `date?`, `idempotencyKey` | `{ duplicate, entry, period, advance }`. Applies only to the advance's own deduction period; must be `disbursed`/`partially_settled`; ≤ advance outstanding (409 `OVER_SETTLEMENT`) and ≤ period `remaining` (409 `EXCEEDS_REMAINING`). |
| `POST /employee-advances/:id/settlements/:entryId/reverse` | `reason` | reversal entry + period + advance (outstanding restored). |
| `POST /employee-advances/:id/reversals` | `reason` | `pending` → `cancelled` (no cash); `disbursed` → `reversed` (reverses the cash outflow). 409 `HAS_SETTLEMENTS` if anything was settled (reverse those first); 409 `ALREADY_REVERSED`. |
| `POST /employee-advances/:id/reassign` | `periodId`, `reason`, `idempotencyKey` | `{ duplicate, advance }`. Explicit move of the deduction period: before any settlement, same employee and currency, target period open (400 `SAME_PERIOD`, 409 `INVALID_STATE`); logged as an `adjustment` ledger entry. |

*Advance object:* `{ id, ref, employeeId, currency, amount, settled, outstanding, status, deductionPeriodId, deductionPeriodKey, requestedDate, disbursement, reversal, note, createdBy, createdAt }`.

## 13. Error codes

Status is the HTTP status. Codes not listed here are in the platform table (§1.5).

**Auth and users**

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no valid session |
| `INVALID_CREDENTIALS` | 401 | wrong login or current password |
| `FORBIDDEN` / `FORBIDDEN_FIELD` / `CSRF_INVALID` | 403 | missing permission / forbidden body field / CSRF |
| `LOGIN_RATE_LIMITED` / `RATE_LIMITED` | 429 | rate limits |
| `WEAK_PASSWORD` | 400 | password policy |
| `USER_NOT_FOUND` | 404 | |
| `ADMIN_ACCOUNT_PROTECTED` | 403 | owner accounts cannot be changed via the API |
| `USERNAME_TAKEN` | 409 | duplicate username |

**Models, lookup, stock, series**

| Code | Status | Meaning |
|---|---|---|
| `MODEL_NOT_FOUND`, `SERIES_NOT_FOUND`, `SIZE_NOT_FOUND` | 404 | |
| `MODEL_UNAVAILABLE` | 404 | model missing or archived when selling |
| `MODEL_ARCHIVED` | 409 | stock operation on an archived model |
| `MODEL_NUMBER_TAKEN`, `BARCODE_TAKEN`, `MODEL_NUMBER_EXHAUSTED` | 409 | model number / barcode collisions |
| `INVALID_MODEL_NUMBER`, `DUPLICATE_SIZE`, `SIZE_NOT_IN_MODEL`, `LAST_SIZE` | 400 | |
| `SIZE_EXISTS`, `SIZE_HAS_STOCK` | 409 | |
| `INVALID_SERIES` | 400 | series composition rule violated (`details` lists problems) |
| `SAME_LOCATION`, `NO_DIFFERENCE` | 400 | transfer / adjust |
| `INSUFFICIENT_STOCK` | 409 | not enough quantity (FIFO could not cover the request) |
| `SHIPMENT_IN_PROGRESS`, `SHIPMENT_DUPLICATE`, `IDEMPOTENCY_MISMATCH` | 409 | shipment idempotency |
| `EMPTY_CODE`, `INVALID_QR`, `OBSOLETE_QR` | 400 | lookup / QR |
| `CODE_NOT_FOUND`, `QR_NOT_FOUND` | 404 | |
| `QR_OBSOLETE` | 409 | QR of an archived model |
| `CONFLICT` | 409 | concurrent modification; retry |

**Sales and returns**

| Code | Status | Meaning |
|---|---|---|
| `EMPTY_INVOICE` | 400 | |
| `RATE_REQUIRED` | 400 | SYP operation without a rate |
| `INVOICE_NOT_FOUND` | 404 | |
| `ALREADY_CANCELLED`, `EXCHANGE_NOT_CANCELLABLE`, `HAS_RETURNS` | 409 | cancellation rules |
| `INVOICE_CANCELLED` | 409 | return on a cancelled invoice |
| `RETURN_EXCEEDS` | 409 | quantity above what is returnable |
| `INVALID_ITEM`, `EXCHANGE_ITEMS_REQUIRED`, `EXCHANGE_CURRENCY_MISMATCH` | 400 | return / exchange validation |
| `RANGE_REQUIRED`, `INVALID_RANGE` | 400 | report / finance period |

**Finance and cash**

| Code | Status | Meaning |
|---|---|---|
| `INVALID_AMOUNT_PRECISION` | 400 | USD more than 2 decimals / SYP fraction |
| `INVALID_AMOUNT`, `INVALID_CURRENCY` | 400 | internal posting guards |
| `CASH_NOT_FOUND`, `EXPENSE_NOT_FOUND` | 404 | |
| `CASH_REVERSE_VIA_SOURCE` | 409 | only manual movements can be reversed here |
| `CASH_ALREADY_REVERSED`, `ALREADY_REVERSED` | 409 | double reversal |

**Suppliers**

| Code | Status | Meaning |
|---|---|---|
| `SUPPLIER_NOT_FOUND`, `SUPPLIER_INVOICE_NOT_FOUND`, `ENTRY_NOT_FOUND`, `CREDIT_NOT_FOUND`, `ALLOCATION_NOT_FOUND`, `SETTLEMENT_NOT_FOUND` | 404 | |
| `SUPPLIER_INACTIVE` | 409 | |
| `SUPPLIER_REQUIRED` | 400 | consignment without supplier |
| `DUPLICATE_SUPPLIER` | 409 | same normalised name + phone (`details.id`) |
| `DUPLICATE_INVOICE` | 409 | supplier invoice number already used |
| `INVALID_DATES`, `INVALID_LINK`, `AMOUNT_TOO_SMALL`, `AMOUNT_MISMATCH` | 400 | |
| `USE_SETTLEMENT_WORKFLOW` | 400 | `consignment_settlement` invoices are created by settlements only |
| `CONSIGNMENT_NOT_PURCHASE` | 409 | consignment series on a purchase invoice |
| `SERIES_SUPPLIER_MISMATCH` | 409 | series belongs to another supplier |
| `INVOICE_OVERPAID` | 409 | exceeds the invoice remainder |
| `INVOICE_REVERSED` | 409 | invoice already reversed |
| `ALLOCATION_EXCEEDS_CREDIT` | 409 | exceeds the available credit |
| `ALREADY_RELEASED` | 409 | |
| `CROSS_CURRENCY_CONFIRM_REQUIRED` | 409 | different currencies without `crossCurrency` confirmation |
| `CROSS_CURRENCY_NOT_ALLOWED` | 409 | credit notes / return credits across currencies |
| `RATE_AMOUNT_MISMATCH` | 400 | amounts and entered rate inconsistent |
| `CANNOT_REVERSE_REVERSAL`, `REVERSE_PAYMENTS_FIRST`, `REVERSE_VIA_SETTLEMENT` | 409 | reversal rules |
| `CONSIGNMENT_PRICE_MISSING` | 409 | settling an unpriced series (or "adjust" with no price) |
| `CONSIGNMENT_PRICE_EXISTS` | 409 | price exists; use `adjust: true` with a reason |
| `CONSIGNMENT_OVER_SETTLEMENT` | 409 | more than sold-and-unsettled |
| `MIXED_CURRENCY_SETTLEMENT` | 400 | selected series priced in different currencies |
| `NOT_SUPPLIER_CONSIGNMENT` | 409 | series is not this supplier's consignment |
| `SETTLEMENT_IN_PROGRESS`, `RETURN_IN_PROGRESS` | 409 | claim in flight |
| `SETTLEMENT_INCONSISTENT` | 409 | settled quantity could not be released (manual review) |
| `PRICE_NOT_CONSIGNMENT` | 400 | agreed price on non-consignment receipt |

---

**Employees and payroll**

| Code | Status | Meaning |
|---|---|---|
| `EMPLOYEE_NOT_FOUND`, `PERIOD_NOT_FOUND`, `ADVANCE_NOT_FOUND`, `ENTRY_NOT_FOUND` | 404 | unknown record |
| `USER_NOT_FOUND`, `USER_IS_OWNER` | 400 | invalid linked login account |
| `USER_ALREADY_LINKED` | 409 | account already linked to another employee |
| `PERIOD_EXISTS` | 409 | one period per employee and month |
| `EMPLOYEE_INACTIVE` | 409 | no new periods or advances |
| `CURRENCY_MISMATCH` | 400 | currency differs from the employee / period / advance |
| `CURRENCY_LOCKED` | 409 | currency fixed once periods or advances exist |
| `IDEMPOTENCY_KEY_REUSED` | 409 | the key was already used for a request with different material parameters |
| `BEFORE_HIRE` | 409 | month before the employee's hire month |
| `HISTORICAL_SALARY_UNKNOWN` | 409 | month older than the known salary (`salaryEffectiveFrom`, else the record's creation month): the current salary cannot be used as its snapshot |
| `INACTIVE_ADVANCE_CARRY` | 409 | inactive employee whose scheduled advance exceeds the remaining salary and cannot be carried to a new month (owner decision needed); nothing is written, the advance stays outstanding |
| `INVALID_EFFECTIVE_MONTH` | 400 | `salaryEffectiveFrom` in the future |
| `INVALID_STATE` | 409 | action not allowed in the record's current state (`details.status`) |
| `PERIOD_CLOSED`, `PERIOD_NOT_OPEN` | 409 | closed period cannot change; advance target period not open |
| `PERIOD_EMPLOYEE_MISMATCH` | 400 | period belongs to another employee |
| `EXCEEDS_REMAINING` | 409 | amount above the period's remaining payable |
| `OVER_SETTLEMENT` | 409 | settlement above the advance's outstanding amount |
| `ADVANCES_OPEN` | 409 | closing a period that still has open advances assigned |
| `HAS_SETTLEMENTS` | 409 | advance has settlements: reverse them first |
| `ALREADY_REVERSED` | 409 | entry/advance already reversed |
| `NO_SALARY_DUE` | 409 | nothing payable for the month (paid, or covered by advance deduction) |
| `FUTURE_PERIOD` | 400 | salary of a future month |
| `EMPLOYEE_REQUIRED`, `EMPLOYEE_ONLY_FOR_SALARY` | 400 | employee missing for the salary category / sent with another category |
| `CONCURRENT_UPDATE` | 409 | another operation on the same employee is in flight: retry |
| `NO_ELIGIBLE_PERIOD` | 409 | no open month within 24 months for an advance |
| `SAME_PERIOD` | 400 | reassign target equals the current period |
| `INVALID_AMOUNT_PRECISION`, `SALARY_REQUIRED`, `INVALID_PERIOD_KEY` | 400 | validation |


## 14. curl examples

Set up once (Bash). The cookie jar keeps the session; `x-csrf-token` is required on every write.

```bash
BASE=http://localhost:5000/api

# 1) Log in, keep the cookie, capture the CSRF token
CSRF=$(curl -s -c jar.txt -H 'Content-Type: application/json' \
  -d '{"identifier":"admin","password":"Poplar-Local-2026!"}' $BASE/auth/login | jq -r .csrfToken)

# Helper for writes
post() { curl -s -b jar.txt -H 'Content-Type: application/json' -H "x-csrf-token: $CSRF" -X POST "$BASE$1" -d "$2"; }
```

### Create a model with an opening series
```bash
post /models '{
  "name":"Bootcut jeans","brand":"FAF","origin":"local","type":"Trousers","cut":"Bootcut","season":"Summer 2026",
  "costPrice":22,"sellPrice":45,
  "sizes":[{"size":"S"},{"size":"M"},{"size":"L"}],
  "openingSeries":[{"location":"warehouse","sizes":[{"size":"M","qty":2},{"size":"L","qty":1}]}]
}'
```

### Receive a shipment (safe to retry: same key)
```bash
KEY=$(uuidgen)
post /stock/receive '{
  "modelNumber":"FAF-001","location":"warehouse","unitCostUsd":23,"note":"Factory invoice 1203","idempotencyKey":"'"$KEY"'",
  "series":[{"sizes":[{"size":"S","qty":2},{"size":"M","qty":2}]},{"sizes":[{"size":"M","qty":1},{"size":"L","qty":1}]}]
}'
# Running it again with the same $KEY returns 200 with "duplicate": true and the same series.
```

### Transfer, damage, inventory count
```bash
post /stock/transfer '{"modelNumber":"FAF-001","from":"warehouse","to":"shop","items":[{"size":"M","qty":2}]}'
post /stock/damage   '{"modelNumber":"FAF-001","size":"L","qty":1,"location":"shop","reason":"Torn seam"}'
post /stock/adjust   '{"modelNumber":"FAF-001","size":"S","location":"warehouse","newQty":3,"reason":"Month-end count"}'
```

### Scan / look up a code, then sell it
```bash
curl -s -b jar.txt "$BASE/lookup?code=PLP1:FAF-001" | jq '.model.sizes[] | {id,size,shopQty}'

# USD sale (modelId = model.id, sizeId = size.id)
post /invoices '{"currency":"USD","items":[{"modelId":"<modelId>","sizeId":"<sizeId>","qty":1,"unitPrice":45}]}'

# SYP sale (needs usdToSyp in settings)
post /invoices '{"currency":"SYP","items":[{"modelId":"<modelId>","sizeId":"<sizeId>","qty":1,"unitPrice":675000}]}'
```

### Cancel, return (cash) and exchange
```bash
post /invoices/<invoiceId>/cancel '{}'

post /returns '{"invoiceId":"<invoiceId>","mode":"cash","reason":"Wrong size","items":[{"itemIndex":0,"qty":1,"condition":"good"}]}'

post /returns '{"invoiceId":"<invoiceId>","mode":"exchange","reason":"Swap",
  "items":[{"itemIndex":0,"qty":1,"condition":"good"}],
  "newInvoice":{"currency":"USD","items":[{"modelId":"<modelId>","sizeId":"<otherSizeId>","qty":1,"unitPrice":45}]}}'
```

### Finance: opening balance, expense, dashboard
```bash
post /finance/cash '{"currency":"SYP","direction":"in","amount":40000000,"note":"Opening balance","idempotencyKey":"open-syp-2026-10"}'
post /finance/expenses '{"currency":"SYP","amount":3500000,"category":"Rent","description":"Shop rent","idempotencyKey":"rent-2026-10"}'
curl -s -b jar.txt "$BASE/finance/dashboard?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z&tz=Asia/Damascus" | jq '{syp: .SYP.balance, usd: .USD.balance, usdNetProfit: .USD.netProfit, sypNetProfit: .SYP.netProfit}'
```

### Suppliers: invoice, linked payment, advance, cross-currency payment
```bash
SUP=$(post /suppliers '{"name":"Al-Noor Apparel","phone":"0944 111 222"}' | jq -r .id)

# Purchase invoice in USD (liability only, no cash)
INV=$(post /suppliers/$SUP/invoices '{"invoiceNo":"NR-2026-014","invoiceDate":"2026-10-03T00:00:00.000Z","amount":1500,"currency":"USD","idempotencyKey":"nr-014-invoice"}' | jq -r .invoice.id)

# Pay $1000 against it: cash leaves the USD account, allocated immediately
post /suppliers/$SUP/payments '{"amount":1000,"currency":"USD","invoiceId":"'"$INV"'","note":"First instalment","idempotencyKey":"nr-014-pay-1"}'

# Advance (cash out now, stays available until allocated)
post /suppliers/$SUP/advances '{"amount":300,"currency":"USD","idempotencyKey":"nr-adv-1"}'

# Pay a USD invoice with SYP: explicit confirmation and an entered rate are mandatory
post /suppliers/$SUP/payments '{"amount":6000000,"currency":"SYP","invoiceId":"'"$INV"'",
  "crossCurrency":{"settlesAmount":400,"rate":15000},"idempotencyKey":"nr-014-pay-cross"}'
# Only the SYP cash account decreases (6,000,000); the invoice is reduced by $400.
# Without "crossCurrency" the API answers 409 CROSS_CURRENCY_CONFIRM_REQUIRED.
```

### Consignment: receive, agree a price, sell, settle, return
```bash
# Owner receives goods on consignment with the agreed price (no payable, no cash)
post /stock/receive '{"modelNumber":"SMR-001","location":"shop","idempotencyKey":"smr-rcv-1",
  "supplierId":"'"$SUP"'","consignment":true,"consignmentPrice":{"amount":55,"currency":"USD"},
  "series":[{"sizes":[{"size":"M","qty":2},{"size":"L","qty":2}]}]}'

# After customers bought some pieces: what can be settled?
curl -s -b jar.txt $BASE/suppliers/$SUP/settlements/eligible | jq '.items[] | {seriesNo,size,sold,settled,settleable,price}'

# Settle one piece at the agreed price (creates a liability in the price currency; no cash)
post /suppliers/$SUP/settlements '{"items":[{"seriesId":"<seriesId>","size":"M","qty":1}],"note":"First settlement","idempotencyKey":"sst-1"}'

# Return unsold pieces to the supplier (optional credit; never cash)
post /suppliers/$SUP/returns '{"items":[{"seriesId":"<seriesId>","size":"L","qty":2}],"reason":"Does not sell","idempotencyKey":"srt-1"}'
```

### Typical failures
```bash
# Missing CSRF header on a write -> 403 CSRF_INVALID
curl -s -b jar.txt -H 'Content-Type: application/json' -X POST $BASE/stock/damage -d '{}'

# A received series with 3 pieces of a size -> 400 INVALID_SERIES (message explains how to fix it)
post /stock/receive '{"modelNumber":"FAF-001","idempotencyKey":"too-many-0001","series":[{"sizes":[{"size":"M","qty":3}]}]}'

# An employee sending unitCostUsd -> 403 FORBIDDEN_FIELD; any /suppliers or /finance call -> 403 FORBIDDEN
```

### Employee salary and advance (employee-centred flow)
```bash
EMP=$(post /employees '{"name":"Laila Ahmad","salary":1000,"currency":"USD"}' | jq -r .id)

# Record an advance: created + disbursed in one step; the deduction month is chosen automatically
post /employee-advances/issue '{"employeeId":"'"$EMP"'","amount":300,"idempotencyKey":"adv-0001"}'

# What is payable now? (nothing is created by this call)
curl -s -b jar.txt "$BASE/employees/$EMP/payroll-summary" | jq '{periodKey, entitlement, scheduledSettlement, remainingPayable, canPay}'
#   -> entitlement 1000, scheduledSettlement 300, remainingPayable 700

# Pay part of the salary as a Finance expense (month auto-created and approved; the 300 advance is settled automatically)
post /finance/expenses '{"currency":"USD","amount":400,"category":"رواتب","employeeId":"'"$EMP"'","idempotencyKey":"sal-0001"}'
post /finance/expenses '{"currency":"USD","amount":300,"category":"رواتب","employeeId":"'"$EMP"'","idempotencyKey":"sal-0002"}'
# a further payment -> 409 NO_SALARY_DUE
```
