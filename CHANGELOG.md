# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). "Poplar v3" is the third generation of the application; the `package.json` files carry their own, separate version numbers, and no release tags have been cut yet.

## Unreleased

_Nothing yet._

## Poplar v3 — 2026-10-19 (first public release)

First publication of the project on GitHub. It rebuilds v2 around a layered architecture and adds the dual-currency cash ledger, supplier accounts and employee payroll.

### Added

- **Series-based stock.** Stock is a set of series (`SER-000123`) at one location with a quantity per size; sales, transfers and damage consume the oldest series first (FIFO); cancellations and returns restore the series they came from.
- **Models and QR codes.** Immutable model numbers (for example `FAF-001`), printable QR codes (`PLP1:<modelNumber>`), optional per-size barcodes and camera scanning.
- **Cashier (POS).** Scan or search, per-line price edit, sales in USD or SYP (SYP with exchange rate), price-flag warnings, returns and same-currency exchanges, keyboard shortcuts.
- **Two independent cash accounts** (SYP and USD) backed by an append-only `cash_movements` ledger; no combined total and no conversion between them.
- **Finance dashboard (owner).** Per-currency cash balance and flow, revenue, refunds, COGS, gross and net profit, expenses, supplier payments and payables, previous-period comparison. Figures that cannot be computed exactly are shown as unavailable instead of estimated.
- **Supplier accounts (owner).** Per-supplier ledger in each entry's currency: invoices, payments, advances, credit notes, adjustments, explicit allocation, reversals, and **consignment** goods that are paid for only when sold, with settlements and returns to the supplier.
- **Employee accounts: salary and advances (owner).** Automatic monthly payroll periods, salary payments through Finance → Expenses (partial payments supported), advances settled from salary with automatic carry-forward, idempotent atomic payments, corrections as reversals.
- **Security.** Server-side sessions, CSRF token, central RBAC with owner-only permissions, login rate limiting, `helmet` CSP, strict `zod` validation, server-side removal of cost and profit fields for employees.
- **Safe data tooling.** `reset-dev`, `migrate:*`, `seed` and `backup-db` scripts behind a safety gate that refuses production, remote and unmarked databases; deterministic seed with an independent integrity check (`verifyIntegrity`).
- **Arabic (RTL) interface** with a responsive layout (mobile drawer and bottom navigation).
- **Tests.** 73 unit, 38 HTTP and 9 frontend tests that need no database, plus 133 integration tests that need MongoDB.
- **Documentation.** Overview, features, data model and API reference in `docs/`.

### Repository

- Extended the README (prerequisites, testing and CI, project tree, contributing and security sections) and added `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (ISC), `.editorconfig`, `.gitattributes`, `.gitignore` and `.nvmrc`.
- Added GitHub Actions CI: backend unit and HTTP tests and frontend tests and build on Node 22 and 24, and the integration suites on both a standalone MongoDB and a single-node replica set.
- Added Dependabot configuration, issue forms, a pull request template and `CODEOWNERS`.

### Changed

- Declared the real Node.js requirement: `>= 22.12.0` (the installed Mongoose 9 requires Node 20.19 or newer and Vite 8 requires 20.19 or newer / 22.12+; `node --test` globs used by the test scripts need Node 21 or newer; the previous `>= 18` was wrong).
- Corrected the documented frontend test count (9, not 8).

### Known issues

- **Concurrent same-key advance requests can both answer `201`.** `POST /employee-advances/issue` is a create step followed by a disburse step, and `duplicate` is `created.duplicate && disbursed.duplicate` (`services/employeeFinance.service.js`). When several requests with the same idempotency key race, one can win the create step and another the disburse step, so both report a fresh creation. No data is duplicated (one advance and one cash movement exist, protected by unique keys); only the status code is inaccurate. The test `employee-advance-flow` › *3. retries* asserts exactly one `201` and failed once in a full parallel local run while passing five times in isolation. CI therefore runs the integration files serially. A proper fix needs a decision on which request owns the `201`.
- See *Known limitations* in the [README](README.md#known-limitations) for the product-level limits (cash-only sales, no SYP cost basis, standalone MongoDB not crash-safe, and others).
