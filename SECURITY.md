# Security Policy

Poplar manages stock, sales, cash balances, supplier accounts and employee salaries, so security reports are taken seriously.

## Supported versions

Security fixes are made on the `main` branch (Poplar v3). Older generations (v2) are not supported.

| Version | Supported |
|---|---|
| `main` (v3) | Yes |
| v2 and earlier | No |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: [**Report a vulnerability**](https://github.com/abdullahnidalkhaled-bit/poplar/security/advisories/new) (Security tab → *Report a vulnerability*).

Please include:

- what you found and which component it affects (endpoint, page, script),
- steps to reproduce, or a proof of concept that does not touch data you do not own,
- the impact you expect (for example "an employee can read salary data"),
- the commit you tested.

Do not include real credentials, session cookies or customer/financial data in the report.

What to expect (best effort; this is a small project, not a company with an on-call team):

- an acknowledgement within about 7 days,
- an assessment and a plan, or questions, within about 14 days,
- a fix or mitigation as soon as it can be made safely, with credit in the changelog if you want it.

Please give a reasonable time to fix the problem before disclosing it publicly.

## What is in scope

- Authentication, sessions and CSRF protection
- Authorization: any way for an employee to reach an owner-only (`ADMIN_ONLY`) permission, or to read cost, profit or salary data the server is meant to remove
- Injection (NoSQL operators, unvalidated input), XSS, and unsafe handling of the QR payload
- Anything that lets money or stock be created, lost or double-counted (idempotency, race conditions, ledger or cash integrity)
- Information leaks in error messages, logs or responses
- The safety gate of the destructive scripts (`reset-dev`, `seed --reset`): any way to make them run against a database that is not disposable

## Out of scope

- The **documented local development accounts** (`admin`, `sara`, `omar`, `lina` in the README) exist only after running the seed on a disposable local database. They are public by design. The seed and reset scripts refuse production, remote and unmarked databases. Never run the seed on a deployed system.
- Findings that need physical or administrator access to the machine that runs the server or the database.
- Missing HTTPS when the app is run locally over `http://localhost`. For a real deployment HTTPS is required (see below).
- Behaviour listed under *Known limitations* in the [README](README.md#known-limitations) (for example, a standalone MongoDB is not crash-safe for multi-step financial operations; a replica set is recommended for real data).
- Denial of service through sheer volume of requests, beyond the rate limits that already exist.
- Vulnerabilities in third-party dependencies with no practical exploit path in Poplar (Dependabot tracks dependency updates).

## What the application already does

Server-side sessions stored in MongoDB (HttpOnly, SameSite=Strict cookie, idle and absolute expiry), a CSRF token on state-changing requests, central role-based access control, login rate limiting per IP and account, `helmet` security headers with a content security policy, strict `zod` validation that rejects unknown fields, and server-side removal of cost and profit fields for employees. Details: [docs/01-overview.md §4](docs/01-overview.md#4-security).

## Hardening checklist for deployers

If you run Poplar with real data:

- Set `NODE_ENV=production` and a strong `SESSION_SECRET` (32+ characters, generated randomly). Startup fails in production without one.
- Serve it over **HTTPS** (reverse proxy), configure `trust proxy`, and leave `COOKIE_SECURE` at its production default.
- Keep `CORS_ORIGINS` empty when the backend serves the UI itself; otherwise list only the origins you need.
- Bind MongoDB to `127.0.0.1` (or a private network) with authentication, never to a public interface.
- Run MongoDB as a (single-node) replica set and remove `DISABLE_TRANSACTIONS=true`, so multi-step money operations are all-or-nothing even if the process crashes.
- Take backups (`npm run backup-db` writes EJSON files) and store them securely. They contain password hashes, sessions and financial records.
- Never run `reset-dev`, `seed --reset` or the integration tests against the production database.
- Create the owner account with `npm run create-admin` and choose a unique password. Remove or disable any account you do not need.
