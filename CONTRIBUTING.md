# Contributing to Poplar

Thank you for helping improve Poplar. This is an inventory, point-of-sale and finance system that handles real money and real stock, so the rules below are stricter than in a typical web app. Please read them before opening a pull request.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems must **not** be filed as public issues; see [SECURITY.md](SECURITY.md).

## Contents

- [Getting set up](#getting-set-up)
- [Project layout and architecture rules](#project-layout-and-architecture-rules)
- [Rules for money, stock and permissions](#rules-for-money-stock-and-permissions)
- [Database safety](#database-safety)
- [Running the tests](#running-the-tests)
- [Making a change](#making-a-change)
- [Pull request checklist](#pull-request-checklist)
- [Documentation](#documentation)

## Getting set up

You need **Node.js 22.12 or newer** (see `.nvmrc`; CI runs 22 and 24) and a **local MongoDB** (8.x is what CI and the maintainers use). The project is local-first: there is no hosted database in the setup.

```bash
git clone https://github.com/abdullahnidalkhaled-bit/poplar.git
cd poplar

# 1) MongoDB, bound to localhost only
mongod --dbpath ./mongo-data --bind_ip 127.0.0.1 --port 27017

# 2) Backend (API on :5000)
cd backend
cp .env.example .env
npm ci
npm run create-admin        # first owner account; there is no public registration
npm run dev

# 3) Frontend (Vite on :5173, proxies /api to :5000)
cd ../frontend
npm ci
npm run dev
```

To get realistic sample data on a **disposable** database, use the reset → migrate → seed workflow described in the [README](README.md#optional-load-the-official-sample-data-disposable-local-database-only).

## Project layout and architecture rules

```
backend/src
  routes/        one router per resource; every route declares its permission with requirePermission
  validations/   zod schemas (strict: unknown fields are rejected)
  controllers/   read req.valid, call exactly one service, answer with res.success()
  services/      all business logic
  repositories/  every query, aggregate and atomic update
  models/        Mongoose schemas and indexes
  middleware/    auth, CSRF, security headers, validation, error handler, redaction, presenters
  utils/         money, series, sizes, unitOfWork (runAtomic), errors, pagination, ...
frontend/src     React 19 + Vite, plain CSS tokens, Arabic RTL
```

The full description is in [docs/01-overview.md](docs/01-overview.md). The rules that matter most when you write code:

1. **Keep the layers separate.** A request flows `route → validate → controller → service → repository → model`. Controllers contain no logic; services do not import Mongoose models (new code must not; `finance.service.js` is a known legacy exception); repositories are the only place that builds queries.
2. **Validate everything at the edge** with a strict zod schema in `validations/`. Never trust `req.body` directly; use `req.valid`.
3. **Permissions live in one place**, `backend/src/config/permissions.js`. Do not write ad-hoc `if (user.role === ...)` checks. A permission is either `ADMIN_ONLY` (cannot be delegated) or grantable. Sensitive fields (costs, profit, salaries) are removed on the server for employees; hiding them in the UI is never enough.
4. **The UI language is Arabic (RTL).** User-facing text and API error messages are Arabic. Source comments in the existing code are mostly Arabic; follow the style of the file you are editing. Documentation in `docs/` and the repository files are in English.
5. **Follow the surrounding code:** naming, comment density, and idiom. The project has no linter or formatter yet, so consistency with the file you touch is the standard. `.editorconfig` covers whitespace.

## Rules for money, stock and permissions

These are the areas where mistakes cost real money. A change that touches them needs tests for the new behaviour.

- **Integer minor units.** Supplier, cash and payroll amounts are stored and computed as integers (USD in cents, SYP in whole pounds) using the helpers in `utils/money.js` (`toMinorC`, `fromMinor`, ...). Never add or compare floating-point money.
- **Two currencies are never combined.** There is no total across USD and SYP and no implicit conversion. A cross-currency payment needs an explicit rate.
- **Append-only ledgers; corrections are reversals.** Cash movements and supplier/employee ledger entries are not edited or deleted to fix a mistake: post a reversal that keeps the history.
- **Multi-step writes use `runAtomic`** (`utils/unitOfWork.js`). It uses a real transaction on a replica set and compensating undo steps (`ctx.undo(...)`) on a standalone server. Both paths must work: register the undo for every step.
- **MongoDB forbids parallel operations on one transaction session.** Do not use `Promise.all` with the same `ctx`.
- **Money endpoints are idempotent.** They take an `idempotencyKey`, store a fingerprint of the request, answer a repeat with the original result, and answer the same key with different data with `409`.
- **Conditional atomic updates instead of read-then-save.** Counters and statuses change with one conditional update so concurrent requests cannot lose data.
- **Stock is series-based (FIFO).** Quantities are never stored on a model; they are summed from series. Do not introduce a second source of truth.
- **Keep the integrity check honest.** If you add a ledger type or counter, extend `backend/scripts/lib/verify.js` so `verifyIntegrity` still detects partial writes.

## Database safety

- **Never run `reset-dev`, `seed --reset` or any wipe against a database that holds real data.** The scripts go through a safety gate (`scripts/lib/safety.js`) that refuses production, remote and unmarked databases; do not weaken it.
- Run `npm run backup-db` before any migration or destructive step. Backups land in `backend/backups/`, which is git-ignored.
- Integration tests **wipe their database**. The database name in `MONGO_TEST_URI` must contain `test`, otherwise the suites refuse to run. Use a throwaway database, never your working one.
- Never commit `.env`, `mongo-data/`, database dumps or backups. They contain password hashes, sessions and financial records.

## Running the tests

All tests use Node's built-in runner (`node --test`).

| Command | Needs a database | What it covers |
|---|---|---|
| `cd backend && npm test` | no | Unit tests: utils, presenters, pure service logic, validations, error handler |
| `cd backend && npm run test:http` | no | Validation, security headers, auth, CSRF, rate limit, RBAC matrix |
| `cd backend && MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration` | yes | Real flows: stock, sales, cash, finance, suppliers, payroll, migrations, seed |
| `cd frontend && npm test` | no | Pure UI logic (money formatting, payroll rules, user form rules) |
| `cd frontend && npm run build` | no | Production build |

Integration tests that touch money must pass on **both** a standalone `mongod` (run with `DISABLE_TRANSACTIONS=true`) and a single-node replica set (`DISABLE_TRANSACTIONS=false` and `?replicaSet=rs0` in the URI). CI runs both. The recipe for a throwaway replica set is in [docs/01-overview.md §8](docs/01-overview.md#8-testing); never stop the `mongod` you use for development.

There is no component-test runner for React. Keep logic in plain modules (`utils.js`, `payrollUtils.js`, ...) so it can be unit-tested, and check UI changes in a real browser at desktop and phone widths.

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach can be agreed.
2. Branch from `main`: `feat/short-name`, `fix/short-name`, `docs/short-name`.
3. Keep the pull request focused. One concern per PR; no unrelated reformatting.
4. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style: `feat(payroll): ...`, `fix(cash): ...`, `docs: ...`, `test: ...`, `chore(ci): ...`.
5. Push and open a pull request; CI must be green.

### Adding an endpoint (checklist)

1. Zod schema in `backend/src/validations/<resource>.validation.js`.
2. Route in `backend/src/routes/<resource>.route.js` with `validate(...)` and `requirePermission(...)`. Put fixed paths before `/:id`.
3. Controller method that calls one service function.
4. Service function (business rules) and repository functions (queries).
5. If it needs a new permission: add it to `config/permissions.js`, decide `ADMIN_ONLY` or grantable, and update the RBAC tests in `backend/tests/http`.
6. Tests: unit for pure rules, HTTP for validation/RBAC, integration for real flows.
7. Frontend page or component, route guard in `App.jsx`, and the sidebar entry if it has one.
8. Update [docs/04-api.md](docs/04-api.md) (and `02-features` / `03-data-model` if behaviour or collections changed).

## Pull request checklist

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) lists it. In short: tests added and actually run, docs and `CHANGELOG.md` updated, no secrets or data in the diff, and for money/stock/permission changes, both MongoDB topologies pass.

## Documentation

| File | Update it when |
|---|---|
| [README.md](README.md) | setup, scripts, stack or limitations change |
| [docs/01-overview.md](docs/01-overview.md) | architecture, configuration, security, operations or testing change |
| [docs/02-features.md](docs/02-features.md) | a page or a business rule changes |
| [docs/03-data-model.md](docs/03-data-model.md) | a collection, field, index or invariant changes |
| [docs/04-api.md](docs/04-api.md) | an endpoint, parameter, response or error code changes |
| [CHANGELOG.md](CHANGELOG.md) | any user-visible change (under **Unreleased**) |

Document what is true and verified. If something is a known limitation, say so (the README has a *Known limitations* section) instead of leaving it implicit.
