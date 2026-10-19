# Poplar v3

[![CI](https://github.com/abdullahnidalkhaled-bit/poplar/actions/workflows/ci.yml/badge.svg)](https://github.com/abdullahnidalkhaled-bit/poplar/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
![Node.js >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-8.x-47A248?logo=mongodb&logoColor=white)

Inventory, point-of-sale and finance system for a clothing store that keeps stock in two places: the **shop** (محل) and the **warehouse** (مستودع). The user interface and every API message are in Arabic (right-to-left); the brand shown in the UI is *Poplar.tr — إدارة المتجر والجرد*. This documentation is in English.

Poplar tracks stock as **series** (small groups of pieces with 1 or 2 pieces per size), sells in **US dollars or Syrian pounds**, keeps **two independent cash accounts** (one per currency, never added together), and manages **supplier accounts** including **consignment** goods that are only paid for when they sell.

- [Highlights](#highlights)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Local development accounts](#local-development-accounts)
- [Scripts](#scripts)
- [Testing and CI](#testing-and-ci)
- [Documentation index](#documentation-index)
- [Project structure](#project-structure)
- [Status and licence](#status-and-licence)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [Security](#security)

## Highlights

| Area | What it does |
|---|---|
| Series-based stock | Stock is a set of series (`SER-000123`), each at one location with a quantity per size. A received series holds 1 or 2 pieces of every included size. Sales, transfers and damage consume the **oldest series first (FIFO)**; cancellations and returns put pieces back into the series they came from. |
| Models and QR | A model has a unique, immutable number such as `FAF-001`. Quantities are never stored on the model; they are summed from series. Each model has a printable QR code with payload `PLP1:<modelNumber>`, plus optional per-size barcodes. |
| Cashier (POS) | Scan or search, edit the unit price per line, sell in USD or SYP (SYP needs the exchange rate), keyboard shortcuts (F2 focus, F9 finish), price-flag warnings, returns and same-currency exchanges. |
| Two cash accounts | A Syrian-pound cash account and a US-dollar cash account. Every movement touches only the account of the currency that was actually settled. There is no combined total and no conversion between them. Balances come only from the append-only `cash_movements` ledger. |
| Finance dashboard (owner) | One section per currency: cash balance and flow, revenue, refunds, COGS, gross and net profit, expenses, supplier payments, supplier payable and advances, previous-period comparison, daily cash chart. What cannot be computed exactly (SYP profit, because stock cost is stored in USD) is shown as "unavailable", never invented. |
| Supplier accounts (owner) | Per-supplier ledger in each entry's own currency: invoices, payments, advances, credit notes, debit adjustments, explicit allocation of credits to invoices, reversals instead of edits, cross-currency payments only with an explicit rate and confirmation. |
| Employees: salary and advances (owner) | The employee account (`/employees/:id`) is the one place for salary and advance balances; **salaries are paid through Finance → Expenses** (category «رواتب» reveals an employee selector with the server-computed remaining payable, partial payments supported) and advances are recorded from the account. Monthly payroll periods are automatic, advances are settled from the salary automatically (the part the salary cannot absorb is carried to the next month), every payment is atomic and idempotent, cash moves only for real cash, and corrections are reversals. See [docs/02-features.md](docs/02-features.md#218-employees-financial-accounts-salary-payments-and-advances-الموظفون). |
| Consignment | Goods received on consignment create no debt and no cash movement. The store pays the supplier only for pieces actually sold, at the agreed per-piece price in the agreed currency, through a settlement. Unsold pieces can be returned to the supplier. |
| Security | Server-side sessions in MongoDB (HttpOnly, SameSite=Strict cookie), CSRF token, central RBAC with admin-only permissions, login rate limiting, helmet CSP, strict zod validation, and server-side removal of cost and profit fields for employees. |
| Safe data tooling | Reset, migrate and seed scripts behind a safety gate that refuses production, remote and unmarked databases. Deterministic seed with an independent integrity check. |

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js >= 22.12, Express 5, Mongoose 9 (MongoDB), zod 3 (strict validation), pino 10 (logging), helmet, express-rate-limit, cors, dotenv, qrcode. CommonJS. |
| Database | Local MongoDB (standalone or replica set). Default URI `mongodb://127.0.0.1:27017/poplar`. |
| Frontend | React 19, Vite 8, React Router 7, jsQR (camera QR scanning). Plain CSS (`tokens.css`, `base.css`, `inventory.css`, `auth.css`, `suppliers.css`). ES modules. |
| Tests | Node's built-in test runner (`node --test`) for backend and frontend. |
| Ports | Backend `5000`; frontend dev server `5173` (proxies `/api` to `5000`). In production the backend serves the built frontend on `5000`. |

## Quick start

**Prerequisites:** Node.js **22.12 or newer** (`.nvmrc` pins 22; CI runs 22 and 24) and a local **MongoDB** server (8.x is what CI and the maintainers use). No cloud database is involved.

The project uses a **local MongoDB only**. Start order: `mongod`, then backend, then frontend.

```bash
# 0) Get the code
git clone https://github.com/abdullahnidalkhaled-bit/poplar.git
cd poplar

# 1) MongoDB: run mongod bound to 127.0.0.1:27017 with a data folder (mongo-data/ is git-ignored)
mongod --dbpath ./mongo-data --bind_ip 127.0.0.1 --port 27017

# 2) Backend
cd backend
cp .env.example .env          # then edit if needed (see docs/01-overview.md for every variable)
npm install

# 3) Create the first owner account (no public registration exists)
npm run create-admin          # asks for username, display name and a hidden password

# 4) Run the API on :5000
npm run dev

# 5) Frontend (new terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

One-command production style run (everything on `:5000`):

```bash
cd frontend && npm run build && cd ../backend && npm start
```

### Optional: load the official sample data (disposable local database only)

The dual-currency sample data is built by the **reset → migrate → seed** workflow. All three commands go through a safety gate and require you to confirm the database name (`poplar` below). Run them from `backend/`:

```bash
npm run reset-dev -- --confirm-db=poplar --mark-disposable   # wipe every project collection (first time: --mark-disposable marks the DB as disposable)
npm run migrate:suppliers -- --apply                          # create collections and indexes for all models (dry run without --apply)
npm run seed -- --confirm-db=poplar                           # build sample data through the real services, then an integrity check
```

- `--mark-disposable` is needed **once**, the first time a database is wiped. It writes the `_environment` marker document and is your explicit approval that this database may be erased.
- On an already-seeded database, `seed` refuses to run unless you add `--reset` (`npm run seed -- --confirm-db=poplar --reset`).
- **`--keep-users`** (`npm run seed -- --confirm-db=poplar --reset --keep-users`) rebuilds all business data but **does not touch** `users` (accounts, roles, permissions, password hashes), `sessions` or `settings` (exchange rate); mock data is attributed to the existing active owner. Take a copy first with `npm run backup-db` (EJSON of every collection into `backend/backups/`).
- The seed is deterministic: running it again produces identical data.
- **Never run `reset-dev` or `seed --reset` against a database that holds real data.**

Details of the gate, the migration and the integrity check are in [docs/01-overview.md](docs/01-overview.md).

## Local development accounts

These accounts exist only after running the seed on a local development database. They are **public, throwaway credentials for sample data**: never run the seed on a deployed system, and create your real owner with `npm run create-admin`.

| Username | Password | Role / access |
|---|---|---|
| `admin` | `Poplar-Local-2026!` | Owner: everything |
| `sara` | `Shop-Staff-2026` | Employee with default permissions |
| `omar` | `Stock-Keeper-2026` | Employee: defaults plus stock adjust (inventory count) and cancel invoices |
| `lina` | `Cashier-Desk-2026` | Employee: cashier only (`models.read`, `invoices.create`, `returns.create`, `settings.read`) |

Sample data produced by the seed (a live database that has been used will differ): 9 models, 39 series, 24 shipments, 158 stock movements, 18 customer invoices, 6 returns, 8 suppliers, 8 supplier invoices, 18 supplier ledger entries, 5 allocations, 3 settlements, 2 supplier returns, 48 cash movements and 6 expenses, plus payroll: 4 employees (USD, USD, SYP, one terminated), 6 payroll periods (closed, paid, approved/partially paid, overdue, draft), 4 advances (settled, disbursed, pending) and 16 ledger entries. Final cash balances: **11,540,000 ل.س** and **$59.38** (never summed).

## Scripts

Backend (`backend/package.json`):

| Command | Purpose |
|---|---|
| `npm start` | Run the API (`node src/server.js`). Also serves `frontend/dist` if it exists. |
| `npm run dev` | Run the API with nodemon. |
| `npm test` | Unit tests (`tests/unit`). No database needed. |
| `npm run test:http` | HTTP tests (`tests/http`): validation, security, auth, CSRF, rate limit, RBAC. No database needed. |
| `npm run test:integration` | Integration tests (`tests/integration`). Needs `MONGO_TEST_URI`; skipped otherwise. |
| `npm run test:all` | Unit + HTTP + integration. |
| `npm run create-admin` | Create the first owner (`-- --additional` adds another owner, `-- --reset` resets an owner's password). |
| `npm run reset-dev -- --confirm-db=<name> [--mark-disposable]` | Wipe all project collections of a disposable local database. |
| `npm run migrate:suppliers [-- --apply] [-- --rollback --apply]` | Suppliers and cash migration; also builds **all** collections and indexes (including the payroll collections). Dry run by default. |
| `npm run seed -- --confirm-db=<name> [--reset] [--keep-users]` | Build the official sample data (including employees paid through the salary-expense path) and verify integrity. `--keep-users` leaves accounts, sessions and settings untouched. |
| `npm run backup-db` | Read-only EJSON backup of every collection of the configured database into `backend/backups/`. Run before any destructive step. |
| `npm run migrate [-- --apply]` | One-time v2 to v3 data migration (existing v2 data only). |
| `npm run migrate:series [-- --apply]` | One-time migration of legacy quantities into `balance` series. |

Frontend (`frontend/package.json`):

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on `:5173` with `/api` proxied to `:5000`. |
| `npm run build` | Production build into `frontend/dist`. |
| `npm run preview` | Preview the production build. |
| `npm test` | Frontend unit tests (money formatting, payroll UI rules, user form rules). |

## Testing and CI

All tests use Node's built-in runner. Without a database: `cd backend && npm test` (73 unit), `npm run test:http` (38 HTTP) and `cd frontend && npm test` (9). With a throwaway MongoDB database whose name contains `test` (the suites wipe it and refuse any other name):

```bash
cd backend
MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
```

[GitHub Actions](.github/workflows/ci.yml) runs on every push to `main` and every pull request: backend unit and HTTP tests and frontend tests plus production build on Node 22 and 24, and the integration suites against both a standalone MongoDB (compensating-rollback path) and a single-node replica set (real transactions). Details, per-suite coverage and the replica-set recipe: [docs/01-overview.md §8](docs/01-overview.md#8-testing).

## Documentation index

| File | Contents |
|---|---|
| [docs/01-overview.md](docs/01-overview.md) | Architecture and layers, configuration, security, running and deployment, database workflow and safety gate, migrations, tests, frontend architecture, troubleshooting, known limits |
| [docs/02-features.md](docs/02-features.md) | Every user-facing page and every business rule, with the permission each action needs |
| [docs/03-data-model.md](docs/03-data-model.md) | Every collection: fields, indexes, relationships, invariants, idempotency keys, money representation |
| [docs/04-api.md](docs/04-api.md) | Every REST endpoint: permission, parameters, responses, error codes, idempotency, curl examples |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, architecture rules, rules for money/stock/permissions, database safety, tests, pull request checklist |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability, scope, and a hardening checklist for deployers |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and known issues |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |

## Project structure

```
poplar/
├── README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md, CODE_OF_CONDUCT.md, LICENSE
├── .github/                      CI workflow, Dependabot, issue forms, pull request template, CODEOWNERS
├── .editorconfig, .gitattributes, .gitignore, .nvmrc
├── docs/                         01-overview, 02-features, 03-data-model, 04-api
├── mongo-data/                   local MongoDB data folder (created by you, git-ignored, not source code)
├── backend/
│   ├── .env.example
│   ├── backups/                  EJSON backups and reconciliation reports written by migrations (git-ignored contents)
│   ├── scripts/
│   │   ├── create-admin.js       owner creation / password recovery
│   │   ├── reset-dev.js          wipe a disposable local database (safety gate)
│   │   ├── seed.js               deterministic dual-currency sample data
│   │   ├── migrate-v3.js         v2 products -> v3 models
│   │   ├── migrate-series.js     legacy quantities -> balance series
│   │   ├── migrate-suppliers.js  suppliers + cash schema/indexes + reconciliation report
│   │   └── lib/                  safety.js (gate), verify.js (integrity check), plan.js, seriesPlan.js
│   ├── src/
│   │   ├── app.js                builds the Express app (no DB; testable)
│   │   ├── server.js             startup and graceful shutdown
│   │   ├── config/               constants.js, env.js, db.js, permissions.js
│   │   ├── routes/               one router per resource; index.js mounts them
│   │   ├── validations/          zod schemas per endpoint (common.js = shared primitives)
│   │   ├── controllers/          read req.valid, call one service, reply with res.success()
│   │   ├── services/             all business logic (never import Mongoose models)
│   │   ├── repositories/         every query, aggregate and atomic update
│   │   ├── models/               Mongoose schemas and indexes
│   │   ├── middleware/           auth, security, validate, errorHandler, redact, presenters/, ...
│   │   └── utils/                money, series, sizes, unitOfWork, errors, pagination, password, ...
│   └── tests/                    unit/, http/, integration/, helpers/
└── frontend/
    ├── vite.config.js            dev proxy /api -> :5000
    ├── tests/                    utils.money.test.js, payroll.utils.test.js, users.utils.test.js
    └── src/
        ├── main.jsx, App.jsx     entry, routes, permission guards
        ├── api.js, auth.jsx      fetch wrapper with CSRF; auth context
        ├── utils.js              money formatting, labels, date helpers
        ├── pages/                Login, Dashboard, Models, ModelDetail, ModelForm, ReceiveShipment, Scan,
        │                         InventoryLog, Movements, Cashier, Invoices, Reports, Settings, Users,
        │                         Finance, Suppliers, SupplierDetail, Employees, EmployeeAccount, Forbidden
        ├── components/           layout/AppShell, ui/* (incl. PageHeader, ActionMenu), inventory/*, suppliers/SupplierForms, finance/ExpenseFormModal, payroll/PayrollForms, qr/QrScanner, ReturnModal
        ├── hooks/                useAsync, useDebounced
        └── styles/               tokens, base, inventory, auth, suppliers
```

## Status and licence

- Version 3 of an internal tool, running on a local MongoDB. Released under the [ISC licence](LICENSE).
- The local development database has been rebuilt with the reset → migrate → seed workflow. No production or real-data database has had `migrate:suppliers` applied (see below).
- Browser verification of the UI used headless Edge and Chrome driven over the DevTools protocol, not a cross-browser manual pass.

## Known limitations

- **Sales are cash-only.** There are no unpaid or partially paid customer invoices and no customer receivables; the seed contains none.
- **Damaged customer returns of consignment goods need manual reconciliation.** They are not automatically subtracted from the sold quantity used for supplier settlements.
- **SYP cost of goods and profit are unavailable.** Inventory cost is stored in USD and there is no SYP cost basis; a separately labelled estimate is shown but never enters totals.
- **No exchange gain/loss entries** are ever posted (cross-currency supplier payments store the entered rate only).
- **No cash swap between the two accounts.** A currency swap is two manual movements, one in each account.
- **Historical pre-release records have no cash movements.** Sales, cash refunds and supplier payments made before the cash ledger existed are reported by the migration and the Finance banner, not posted automatically; the owner enters opening balances manually.
- **Standalone MongoDB is not crash-safe for multi-step financial operations** (compensating undo handles errors and concurrency, not a process kill); a replica set gives real transactions. The integrity check (`verifyIntegrity`) detects crash residue. See docs/01-overview.md §5.4. Deployment decision for the owner.
- **Advances of inactive employees that exceed the remaining salary** are refused (`INACTIVE_ADVANCE_CARRY`) and stay outstanding until the owner decides how to settle them.
- **Months before the hire month or before the known salary month** cannot be created; back-dating needs an explicit `salaryEffectiveFrom` on the employee.
- **Legacy payroll payments are not in Finance expenses.** Salary payments made through Finance → Expenses are (they are expenses); payments recorded earlier through the removed Payroll page have only a cash movement. Both stay reversible.
- **No payroll statement export/print.** The project has no export capability; the ledger is viewable on screen only.
- **Payroll permissions are owner-only.** Delegation needs moving a permission name from `ADMIN_ONLY` to the grantable set (see docs/01-overview.md).
- **The production database has not had `migrate:suppliers` applied.** Dry-run it first and back it up before `--apply`.
- Browser verification used headless Edge and Chrome (both Chromium). Firefox, Safari and real touch devices were not tested. The project has no lint or type-check scripts.

- **Concurrent same-key advance requests can both answer `201`.** `POST /employee-advances/issue` reports a fresh creation when either of its two steps (create, disburse) did new work, so under a heavy race with one idempotency key two requests can both say `201`. Only one advance and one cash movement are ever created; the status code is the only inaccuracy. See [CHANGELOG.md](CHANGELOG.md#known-issues).
- The development tool `nodemon` pulls in a dependency chain (`chokidar` → `braces`) with a reported denial-of-service advisory; it affects the dev server only. `npm audit --omit=dev` reports no vulnerabilities for the production dependencies.

More operational limits (HTTPS, audit trail, concurrent inventory counts, partial-return series split, camera requirements) are in [docs/01-overview.md](docs/01-overview.md#known-limits).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: Poplar handles real money and stock, so there are strict rules about integer money, idempotent endpoints, atomic multi-step writes, permissions and database safety. Open an issue before starting on anything larger than a small fix, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/abdullahnidalkhaled-bit/poplar/security/advisories/new), not in public issues. See [SECURITY.md](SECURITY.md) for scope and a deployment hardening checklist.
