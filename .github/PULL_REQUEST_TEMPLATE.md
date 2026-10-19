## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behaviour change)
- [ ] Documentation only
- [ ] Tooling / CI / dependencies

## How it was tested

<!-- Commands you ran and what you saw. Do not tick a box you did not actually run. -->

- [ ] `cd backend && npm test`
- [ ] `cd backend && npm run test:http`
- [ ] `cd backend && MONGO_TEST_URI=... npm run test:integration` (throwaway database whose name contains `test`)
- [ ] `cd frontend && npm test`
- [ ] `cd frontend && npm run build`
- [ ] Checked in a real browser (UI changes: RTL layout, narrow/mobile width)

## Checklist

- [ ] Tests added or updated for the new behaviour
- [ ] `docs/` updated if behaviour, endpoints, permissions or collections changed (`02-features`, `03-data-model`, `04-api`)
- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] No secrets, `.env` files, database dumps or backups in the diff

### Only if this touches money, stock, permissions or database scripts

- [ ] Amounts use integer minor units and go through the existing helpers
- [ ] Multi-step writes run inside `runAtomic`, with an undo step for the standalone (non-transaction) path
- [ ] Money endpoints are idempotent (key + request fingerprint) and corrections are reversals, not edits
- [ ] New permissions are declared in `config/permissions.js` and enforced with `requirePermission`
- [ ] Integration tests pass on both standalone MongoDB and a replica set
- [ ] Nothing here can run destructively against a non-disposable database
