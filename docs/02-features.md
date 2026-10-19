# Poplar v3 — Features and Business Rules

This document describes every user-facing page and the business rules behind them. Each section names the **permission** a user needs (see the permission table in [01-overview.md](01-overview.md#45-authorization-rbac)); the server enforces the same permissions on the matching API calls ([04-api.md](04-api.md)). The UI is in Arabic; Arabic labels are quoted where they help you find a control.

## Contents

1. [Roles, navigation and confidentiality](#1-roles-navigation-and-confidentiality)
2. [Pages](#2-pages)
   Login · Dashboard · Models · Model detail · Model form · Receive shipment · QR scan · Series log · Movements · Cashier · Invoices and returns · Reports · Settings · Employees · Finance · Suppliers · Supplier detail · Employee accounts and payroll
3. [Business rules](#3-business-rules)
   Series · FIFO · Receiving and cost · Transfers · Damage and inventory count · Sales and prices · Cancellation · Returns and exchange · Consignment · Settlements · Supplier returns · Supplier ledger · Cash ledger · Finance formulas · Currency rules · Idempotency · Payroll rules

---

## 1. Roles, navigation and confidentiality

**Roles.** `admin` (the owner) has every permission. `employee` accounts have an explicit list of permissions chosen by the owner from a fixed grantable list; owner-only permissions can never be granted.

**Employee defaults** (a new employee gets these): view models and scan, receive shipments (without cost), transfer, record damage, series log, movement log, view invoices, cashier, returns and exchanges, operational dashboard, read the exchange rate. **Not by default:** stock adjust (inventory count) and cancel invoice; the owner can grant them.

**Owner only:** create/edit/archive models, costs and profit, reports, settings, employee management, finance, supplier accounts.

**Sidebar** (each entry appears only if the user has its permission; empty groups are hidden). Three groups: **المبيعات** (الكاشير · الفواتير), **المخزون** (اللوحة · الموديلات · استلام شحنة · مسح QR · سجل الأرتال · سجل الحركات), **الإدارة** (المالية · حسابات التجار · الموظفون · التقارير · الإعدادات). It shows the current exchange rate (`1$ = N ل.س`) or "rate not set", the signed-in user and a logout button. On a phone the sidebar becomes a drawer and a bottom bar offers up to four shortcuts (Dashboard, Cashier, Models, Scan, Invoices) plus a "more" button. A red banner appears if the server cannot be reached. A skip-to-content link is provided. The **Cashier stays mounted (hidden) while you navigate, so the cart is never lost.**

**Shared page pattern.** Every page uses one header (`PageHeader`): optional breadcrumb, title, optional subtitle, **one primary action**, and a "المزيد" menu (`ActionMenu`) for secondary actions. The menu opens on click, moves focus between items with Arrow Up/Down, closes with Escape (focus returns to the trigger) or a click outside, and shows destructive items in red. Destructive and financial actions (archive model, deactivate supplier, cancel invoice, selling below cost, clearing the cart) always go through a confirmation dialog; no browser `confirm()` dialogs remain.

**Financial confidentiality.** Employees never receive cost price, wholesale cost, profit, margins, stock valuation, internal USD accounting amounts or below-cost flags, from any endpoint (the server strips them from every response). They keep the selling price and the amounts the customer pays or receives. Accounting is still computed and stored in full. Employees also never see supplier names, balances, agreed prices or ownership details; operational series responses expose only a plain `ownership` flag (`owned` / `consignment`).

---

## 2. Pages

### 2.1 Login

*Permission: none (public).* Username (or e-mail style identifier) and password, with a show/hide password toggle, client-side validation, a loading state and one generic error message for any failure (unknown user, wrong password, disabled account look identical). After too many failed attempts a rate-limit message appears (15-minute window). The session is restored after a page refresh; logout, expiry or revocation (account disabled, permissions or password changed) returns the user to this page with an explanatory notice.

### 2.2 Dashboard (اللوحة)

*Permission: `dashboard.view`.* The inventory dashboard.

- Header: primary action "receive shipment"; "new model" (owner) and "scan QR" are in the "المزيد" menu; a search box that opens the Models page with the query.
- Cards: pieces in shop, in warehouse, combined (with model and size counts), and — for users with `costs.view` — stock value at cost and at selling price in USD.
- **Attention lists** per model: sizes that need a **factory order** (zero in both locations) and sizes **ready to transfer** from the warehouse (zero in the shop, available in the warehouse, with the warehouse quantity). Counts are shown as pills; each model links to its page.
- The last 8 stock movements, with a link to the full log.
- Empty state when there are no models yet.

### 2.3 Models (الموديلات)

*Permission: `models.read`; "new model" needs `models.manage`.*

- List with search, filters (type, brand, origin foreign/local, and status: "has out-of-stock sizes" or "ready to transfer from warehouse"), 20 per page, stock badges, filters kept in the URL.
- **Search** is tiered: exact model number first, then model-number prefix, then words of name/brand/type matched from their beginning (so `boot` finds *bootcut*), and a mid-word substring match only when nothing else matched. Arabic text is normalised (diacritics removed; alef, yaa, taa marbuta unified). Each result can show why it matched.
- Archived models are hidden from the list unless `includeInactive` is requested through the API.

### 2.4 Model detail

*Permission: `models.read`; each action has its own permission.* Header: primary "receive shipment"; the "المزيد" menu holds transfer, record damage, inventory count, edit, and archive/restore (archive asks for confirmation).

- Overview of the model and a **size table** (shop / warehouse / total per size, availability, "transfer to shop" shortcut on sizes that need it).
- **QR card** (SVG, printable) with payload `PLP1:<modelNumber>`.
- Recent movements of this model (needs `movements.read`) with a link to the filtered log.
- Actions: **Receive shipment** (`stock.receive`), **Transfer** (`stock.transfer`), **Damage** (`stock.damage`), **Inventory count / جرد** (`stock.adjust`), **Edit** and **Archive / Restore** (`models.manage`).
- An archived model shows a warning: it cannot be sold or receive stock, and its QR code is no longer valid; invoices and history are kept.

### 2.5 Model form (create / edit)

*Permission: `models.manage` (owner only).*

- Fields: name, brand, origin (`foreign`/`local`), product type, cut (optional), season (optional), notes, wholesale cost (USD), selling price (USD), sizes (presets XS S M L XL XXL plus custom sizes such as `38`, `40.5`, `2XL`), optional barcode per size, and (create only) **opening series**.
- **Model number**: left blank it is generated per brand (`BRAND-001`, atomic counter; the prefix is the first three Latin letters/digits of the brand, or `MDL` for Arabic brands); a "suggest" button previews the next number without consuming it; or type the number from the physical label. It must match `^[A-Z0-9][A-Z0-9._-]{1,31}$`, is unique, and is **immutable** after creation.
- A size without a barcode gets an internal one (`POP-000001`, ...). Barcodes are unique across all models.
- When editing: add sizes, remove sizes (refused if the size has stock or if it would remove the last size).
- The opening balance entered at creation is stored as ordinary received series (1 or 2 pieces per size, each with a `receive` movement and shipment reference `OPENING`).
- Prices are copied into invoice lines at sale time, so old profit never changes when prices change.

### 2.6 Receive shipment (استلام شحنة)

*Permission: `stock.receive`.*

1. Choose the model (search by number or name; or arrive from a model page).
2. Build the **series** with the series builder: each series is a grid of sizes with `—` / `1` / `2`; between 1 and 20 series per shipment; sizes can be added on the fly (they are added to the model automatically, with an internal barcode).
3. Choose the destination (warehouse by default, or shop), an optional note, and — if you have `costs.manage` — the wholesale cost per piece in this shipment.
4. Owners with `suppliers.manage` can also link the shipment to a **supplier**, mark it **consignment**, and enter the **agreed unit price** in USD or SYP.
5. **Purchase invoice and payment in the same step** (owner, ordinary purchase only). After choosing a supplier, section "3) Purchase invoice and payment" appears (checked by default; untick it to receive stock without any invoice). Enter the supplier invoice number, the invoice total and currency (USD/SYP) and an optional due date; the cost × quantity is only *suggested* for USD, never applied automatically. Then pick the payment state:
   - **Unpaid** — invoice and supplier liability, no cash movement.
   - **Paid in full** — one payment equal to the invoice total, allocated to it; one cash movement out of the invoice currency's cash account.
   - **Partially paid** — one payment of the amount entered (0 < amount < total); the rest stays payable.
   - **From an existing advance** — pick unallocated advances/payments of the same currency and the amount from each; allocation creates **no** new cash movement.
   A live summary separates invoice value, cash leaving now, advance applied (no cash) and the remaining payable.
6. **Consignment** (supplier + "consignment" checkbox) hides the invoice section: receiving creates stock and series owned by the supplier, stores the agreed unit price, and creates **no** invoice, liability or cash movement; sold units are settled later from the supplier account ("Consignment settlements").
7. A confirmation dialog summarises the shipment, the cash outflow, the advance applied and the remaining balance before posting. On success the page shows the invoice number, shipment ref (`SHP-…`), payment ref, amounts, and a link to the supplier account.

Everything in 5 is one atomic operation: stock, series, movements, supplier invoice, payment, cash movement and allocations are committed together or not at all (replica-set transaction, or compensating rollback on a standalone server). The idempotency key makes a retry a no-op (`duplicate: true`).

**Supplier account shortcuts.** On the supplier "Invoices" tab each open invoice has **Pay** (payment form prefilled with the invoice, its currency and the outstanding amount — edit it to the real amount), **Apply advance** (allocation form prefilled with the invoice) and **Credit note** (prefilled with the invoice), plus the originating shipment ref.

The request carries an **idempotency key** created in the browser: a double click or retry never registers the shipment twice (the second answer says "this shipment was already registered"). When a cost is given and differs from the current cost, the model's cost becomes the **weighted average** of old stock and the new pieces (see 3.3). Linking a supplier creates **no liability and no cash movement**; the supplier's invoice is recorded separately from the supplier's account.

### 2.7 QR scan (مسح QR)

*Permission: `models.read`.* Three ways in: a phone/desktop camera (jsQR; requires HTTPS or `localhost`), a handheld scanner that types into the input like a keyboard, or typing a model number. Everything goes through one resolver (`/lookup`), shared with the cashier. Accepted codes: the QR payload `PLP1:<modelNumber>`, a **size barcode** (shows the model and highlights that size), or a plain model number. Clear errors for invalid QR, obsolete QR version, unknown model, archived model, unknown code. The result shows the model overview and a link to the model page.

### 2.8 Series log (سجل الأرتال)

*Permission: `series.read`.* One row per series (balance series with no stock are hidden): series number, model, location, size summary (`S: 1, M: 2`), pieces, status (active / depleted), received date, and a consignment badge ("أمانة"). Search by series number, model number or name; filters: location, status, ownership (owned / consignment), date range; sort by received date, created date, series number or model number (ascending/descending); 25 per page. Clicking a series opens a detail modal: per-size initial and current quantity with totals, movements that touched it, its origin series (for derived series) and derived series.

### 2.9 Movements (سجل الحركات)

*Permission: `movements.read`.* A filterable audit log of every stock change. Types: `sale` (بيع), `receive` (استلام), `transfer` (نقل), `return` (مرتجع), `return_damaged` (مرتجع تالف), `damaged` (تالف), `adjust` (تعديل جرد), `cancel` (إلغاء فاتورة), `supplier_return` (إرجاع للتاجر). Each row: date, type, model, size, quantity effect, from → to, before → after (shop and warehouse), reference (`INV-n`, `RET-n`, `SHP-…`, `SRT-…`, `SER-n`) and reason; the cost per movement is shown only to users who can see costs. Filters: free text (model number prefix, name, reference prefix), type, location, size, series (`?series=SER-…`), date range, sort (date, type, model number, quantity), 25 per page.

### 2.10 Cashier (الكاشير)

*Permission: `invoices.create` (scanning also needs `models.read`; the exchange rate needs `settings.read`).* The page stays mounted but hidden while you visit other pages, so the cart survives navigation. Shortcut hints (F2 focus, F9 finish) sit under the total. Selling any line below wholesale cost and "clear invoice" both ask for confirmation in a dialog; checkout is protected against rapid repeated clicks (a synchronous guard plus a disabled button) so one sale can never post twice. The manual search shows "no matching results" when empty.

- Add items by scanning a size barcode or QR, typing a model number, or the manual search box (then pick a size; the number on each size chip is the quantity available **in the shop**). A size with no shop stock cannot be added; the message says if it exists in the warehouse ("move it to the shop first").
- Per line: quantity stepper (capped at shop stock) and an **editable unit price** (default: selling price in USD, or selling price × rate rounded in SYP).
- Currency: **USD** or **SYP**. Switching converts line prices using the current rate. SYP requires a rate (`RATE_REQUIRED` otherwise).
- **Price flags** per line: `normal`, `below_sell_price`, `below_cost`. The cashier shows warnings and asks for confirmation when any line is sold below cost (loss). Employees do not receive cost, so for them only the selling-price check is shown; the server's decision is final.
- Keyboard: **F2** focuses the scan input, **F9** or **Ctrl+Enter** completes the sale. Beeps confirm good and bad scans.
- Completing the sale takes shop stock **FIFO** and writes sale movements, the invoice and the cash receipt as **one atomic unit**. Invoice numbers come from an atomic counter. The success banner shows the invoice number and the amount.
- **Exchange mode**: started from the Invoices page; the return credit is shown, the replacement is scanned in the **same currency**, and the banner shows what the customer still owes or what is refunded (`creditApplied`, `cashDue`).

### 2.11 Invoices and returns (الفواتير)

*Permission: `invoices.read` to view; `returns.create` for return/exchange; `invoices.cancel` for cancellation; `returns.read` to see the day's returns; `costs.view` for profit columns.* Loading, empty and error states use the shared components (the error banner has a retry button). On phones the Invoices table keeps horizontal scrolling inside its wrapper (seven columns plus expandable details); the page itself does not scroll sideways. Cancelling an invoice opens a confirmation dialog that explains the effect, blocks double submission while the request runs, and ends with a success notice.

- Day picker (default today). Table: number, time, pieces, amount (the net `cashDue` after credit), status, and for the owner the profit. Click a row for item details (actual price, returned quantity, selling price, wholesale and flag for the owner; rate at the time for SYP).
- Status pills: completed, cancelled, partial return, fully returned, "exchange of #n", and the worst price flag (owner only).
- **Cancel** (only for a completed invoice with no returns and not an exchange invoice): all items go back to their original series; the record stays as `cancelled`; the cash receipt is reversed in the same currency.
- **Return / Exchange** (`ReturnModal`): pick items and quantities (cannot exceed what is still returnable), condition `good` (goes back to the shop) or `damaged` (written off, `return_damaged`), reason, and mode: **cash refund** or **exchange** with another piece. The dialog shows the refund value in the invoice currency, and for SYP invoices the exchange-rate effect for the owner.
- A table of the day's returns: number, invoice, items, refunded value, type (cash / exchange → new invoice), exchange-rate difference (owner) and reason.
- The lists show at most 300 rows per query.

### 2.12 Reports (التقارير)

*Permission: `reports.view` (owner).* **Inventory only**: total pieces (shop / warehouse), value at cost (USD) and at selling price, and the attention table (sizes to order from the factory, sizes to transfer from the warehouse). A banner points to Finance (sales, profit, cash and expenses moved there) and is shown only to users who can open Finance. The legacy `GET /reports/summary` (USD-converted totals) still exists, is owner-only and no longer used by the UI.

### 2.13 Settings (الإعدادات)

*Permission: `settings.manage` (owner) to open the page; `settings.read` is enough to read the rate elsewhere.* One setting: the **exchange rate** (how many SYP equal 1 USD). Each SYP invoice stores the rate at the time of sale, so changing the rate never changes old invoices. `lowStockThreshold` exists in the data for compatibility but is retired and unused.

### 2.14 Employees (الموظفون)

*Permission: `users.manage` (owner).* **Login accounts.** The create dialog («حساب دخول جديد») uses the same dialog design as the employee form (same width, header, required markers `*`, field-level messages, cancel/primary buttons, double-submit guard); it keeps its own fields (name, username, password, permissions) and validation (name required, username 3–64 of `A-Za-z0-9._@+-`, password ≥ 10). Reached from Employees → «المزيد» → «حسابات الدخول والصلاحيات» (route `/users`); the sidebar entry «الموظفون» now opens the employee financial accounts (2.18). Table of accounts (name, username, role, active, last login). Actions:

- **Create** an employee: name, username (lowercase letters, digits, `. _ - @ +`; 3–64 chars), password (policy below), and a permission picker (defaults pre-selected).
- **Edit** name and permissions; **disable / enable**; **reset password** (the new password must pass the policy).
- The grantable permissions shown are: view models and scan, receive shipments (no cost), transfer, damage, inventory count, series log, movement log, cashier, view invoices, cancel invoices, returns/exchanges, view returns, operational dashboard, read exchange rate.
- Any permission, status or password change **ends that employee's sessions immediately**. Owner accounts cannot be changed here.
- Password policy: at least 10 characters (max 128), letters and digits, must not contain the username.

### 2.15 Finance (المالية)

*Permission: `finance.manage` (owner only, never grantable).* A period selector (**day / month / custom range**, default current month) applies to all tabs. Tabs:

**لوحة المالية (dashboard).** A switch between **الليرة السورية** and **الدولار الأمريكي**; only one currency is shown at a time and there is **no combined figure anywhere**. Sections:

- *Cash (from the cash ledger only)*: current balance (all time, with movement count), inflows, outflows and net cash of the period (net cash is never called profit).
- *Sales and profitability*: sales revenue (with invoice and piece counts), returns (refunds), net revenue, cost of goods sold, gross profit, operating expenses, inventory write-offs (USD section only, with piece count), net profit.
- *Suppliers and customers*: supplier payments in the period, current supplier payable, supplier advances, customer receivables (always "not supported": sales are cash).
- *Comparison with the previous period of the same length* (net revenue, expenses, net cash, net profit).
- *Daily cash flow chart* and *expenses by category*.
- Items that cannot be computed accurately show **«غير متاح»** with the reason; for SYP, COGS, gross profit and net profit are unavailable and a separate, clearly labelled **estimate** is shown (see 3.12).
- A banner reports completed historical invoices that have no cash movement (not auto-posted).
- A collapsible "definitions" section explains each indicator.

**حركات الصندوقين (cash movements).** The immutable cash ledger with filters (currency, type, period), 25 per page. Columns: date, reference (`CSH-000001`), account, type, source reference, signed amount, creator. Owners can post a **manual deposit/withdrawal** (opening balances and corrections; a note is mandatory; a confirmation dialog states which account is affected) and **reverse manual movements**. All other movements are reversed from their source (cancel invoice, reverse supplier payment, reverse expense).

**المصروفات (expenses).** *«مصروف جديد» adapts to the category (see 2.18): ordinary categories behave as before; the category «رواتب» shows an employee selector and pays a salary (one submission, no other page).* Operating expenses by currency and category (suggested categories include rent, utilities, transport, packaging), 25 per page, filters by currency and period. Posting an expense deducts the amount from the cash account of its currency; **reversal** restores it with an opposite movement.

### 2.16 Supplier accounts (حسابات التجار)

*Permission: `suppliers.manage` (owner only, never grantable). Employees get 403 everywhere.*

- **Summary cards** (never summed across currencies): active suppliers; payable to suppliers in USD and in SYP; supplier advances in USD and in SYP; consignment pieces held, with value at agreed prices per currency and unpriced pieces flagged. A list of suppliers that need attention (payable or consignment stock).
- **List**: search (name, phone, address), filters (account state: due / advance / mixed / settled; active / inactive / all), 20 per page. Columns: supplier (name plus phone), status pill (مسدد بالكامل / عليه مستحقات / رصيد سلفة / مستحقات وسلف معاً), gross payable, available advance, net («عليكم X» / «لكم X»), each line with its own currency (a supplier can have both USD and SYP lines), consignment pieces.
- **Supplier record**: name, phone, address, notes, active flag. The phone is stored as typed but displayed with spaces removed and forced left-to-right (`0988 321 654` shows as `0988321654`) in the list and on the supplier page, so the Arabic right-to-left layout cannot reorder its digit groups. Creating or renaming to the same name + phone as another supplier warns (`DUPLICATE_SUPPLIER`; the owner can confirm to create anyway). Suppliers are **deactivated, never deleted**; an inactive supplier cannot receive new postings.

### 2.17 Supplier detail (`/suppliers/:id`)

*Permission: `suppliers.manage`.* Header actions: edit, deactivate/activate. Posting buttons (disabled for inactive suppliers): **record purchase invoice**, **record payment**, **record advance**, **credit note**, **debit adjustment**. Every posting form has an idempotency key, a mandatory confirmation dialog stating the exact cash effect, a disabled button while saving, and Arabic error messages. Tabs:

| Tab | Contents |
|---|---|
| **نظرة عامة** (Overview) | A separate account block per currency (USD and SYP): gross payable, available advance, net. Totals in each entry's own currency, allocation policy, open invoices, available credits with a "allocate to invoice" action, and "auto-apply" (oldest credit to oldest invoice, same currency only). |
| **فواتير التاجر** (Supplier invoices) | Each invoice in its own currency: number, date, due date (overdue highlight), kind (purchase / consignment settlement), amount, allocated, remaining, pay status (paid / partial / unpaid). |
| **الدفعات والسلف** (Payments and advances) | Every credit (payment, advance, credit note, return credit) with allocated and available amounts, whether it moved cash, cross-currency details, and the append-only **allocation history** (apply / release; sources direct, manual, auto) with a release action. |
| **كشف الحساب** (Ledger) | Chronological statement with a **running balance per currency**, filters (type, currency, dates), cash-effect notes, reversal links and a per-entry **reverse** action. Settlement entries are reversed from the settlement. |
| **بضاعة الأمانة** (Consignment goods) | Per model: received, remaining, in shop, in warehouse, net sold, settled, returned, other, unsettled, value per currency, unpriced pieces. Series with agreed price (set / adjust with history) and the **return to supplier** action. |
| **تسويات الأمانة** (Consignment settlements) | Sold-but-unsettled quantities per series and size with the agreed price in its currency and an estimate; select lines and settle (single currency per settlement); settlement history with a reverse action. |
| **الإرجاعات** (Returns) | History of goods returned to the supplier (value per currency from agreed prices, unpriced pieces, linked credit entry). |

---

### 2.18 Employees: financial accounts, salary payments and advances (الموظفون)

*Permission: `employees.read` to open the list, `payroll.read` for an account (owner only; every action needs its own narrow permission, all owner-only). Not to be confused with 2.14, which manages login accounts.* There is **no separate «الرواتب والسلف» page any more**: the old route `/payroll` (and `/payroll/:id`) redirects to `/employees` (`/employees/:id`, keeping `?period=`).

**List (`/employees`).** Search by name or number (`EMP-000001`), filter by employment status and by month (default current), 20 per page. Columns: employee, status, monthly salary (own currency), **remaining for the selected month**, outstanding advances, month status (open, approved, partially paid, paid, **overdue**, closed, no period). Clicking the row or the name opens the account. Primary action «موظف جديد»; «المزيد» links to login accounts.

**Account (`/employees/:id`).** Header: name, number, job title, status, monthly salary and pay day. Month picker (default: the oldest month that still has a balance, else the current month). Two primary actions: **دفع الراتب** and **تسجيل سلفة**; the full statement has a single entry point, the tab «كشف الحساب» (the former duplicate button was removed). Cards, all computed by the server (`GET /employees/:id/payroll-summary`):
- *Salary of the month*: net entitlement (base + allowances + bonuses − deductions), paid in the month, **remaining payable** (already net of the advance deduction that will be applied).
- *Advances* (kept visually separate from salary): outstanding advances across all months, advances scheduled for deduction in this month, advances settled in this month. An advance is never shown as unpaid salary and is never subtracted twice.
- Open advances table with the deduction month per advance, and «نقل الخصم» / «عكس / إلغاء» where allowed. «المزيد»: allowance/bonus/deduction (before the first payment or settlement of the month), apply scheduled advance deduction now, close the month, edit the employee.
- *Statement tab*: chronological ledger (entitlement, advance disbursement, advance settlement, salary payment, allowances, bonuses, deductions, carry-forward/adjustments, reversals) with filters (this month / all, type, state, dates) and pagination. Each row shows date, reference, type, month, amount, status; reversal rows say which entry they reverse. Posted rows are never edited: «عكس» (reason required) posts a reversal and the original stays visible.

**Pay salary (the same form as Finance → Expenses).** Finance → Expenses → «مصروف جديد»: choosing the category **رواتب** reveals an **employee selector**; choosing an employee loads the server's summary (month, net entitlement, paid so far, advance settlement, remaining) and prefills the amount with the remaining payable; the user can lower it for a partial payment, pick the month (default automatic), the date and the payment method (from the register of the employee's currency, or outside the register). A confirmation dialog states the effect (including which register is debited). From an employee account «دفع الراتب» opens the **same dialog** with the employee preset (no category/employee fields). When nothing is payable the form is disabled and says why (fully paid / covered by advances / closed month / future month). Ordinary categories (rent, utilities, transport…) show no employee fields.

**Record advance (from the employee account only).** Amount, payment method (from the register / outside the register), date, note. The **deduction month is chosen automatically** (the nearest month that is not closed and not fully paid, current month first) and shown before confirmation; «تغيير الفترة» lets the owner pick another open month. One confirmation records **and disburses** the advance (real cash-out from the employee's currency register, or none for «outside the register»). Retries are safe.

**Everything else is automatic:** the month's payroll period is created when first needed and approved at the first salary payment; scheduled advances are settled from the salary at the first payment (oldest advance first, only what the remaining salary can absorb); the rest of an advance is carried to the next eligible month (see 3.18).

## 3. Business rules

### 3.1 Series (الأرتال)

Stock is managed by **series**: a group of pieces of **one model at one location** with a quantity per size and a number like `SER-000123` (atomic counter).

- **Received series rule:** a received series is **non-empty** and every included size has **1 or 2** pieces (not 0, not 3+). Sizes not in the series are simply absent. The rule is **per series**, not per model, so several series may total more than 2 of a size. It is enforced at the zod layer and again in `createReceived` (last line of defence).
- Up to **20 series per shipment**; a size cannot repeat inside one series.
- Kinds: `received` (physical receipt; the 1–2 rule applies), `derived` (created by a partial transfer, at the destination; linked to its root by `originSeries`; later transfers from the same root to the same destination merge into it), `balance` (one per model and location; holds legacy stock and positive inventory-count adjustments; exempt from the 1–2 rule).
- Status: `active` or `depleted`. A series that reaches zero becomes depleted and is **never deleted** (history stays).
- Model quantities are **always summed from series**; nothing stores a total.

### 3.2 FIFO

`sale`, `transfer`, `damage` and negative `adjust` consume the **oldest series first** (ordered by received date, then id; a derived series keeps its origin's received date, so it keeps its age). Each deduction is a conditional atomic update that cannot make a quantity negative; on a concurrent conflict the plan is recomputed (up to 5 attempts) and ends in `CONFLICT`. The split is stored on the movement and on the invoice line (`allocations`), so a cancellation or return restores pieces to the **same series**. Legacy invoices without allocations restore into the shop balance series; any excess over the recorded allocations also goes to the balance series.

### 3.3 Receiving and cost

- A new size name in a shipment is added to the model automatically with an internal barcode.
- If a unit cost is supplied (needs `costs.manage`), the model's cost becomes the **weighted average** `(existing pieces × current cost + new pieces × new cost) / total`, rounded to 4 decimals (the new cost if no stock existed), using an optimistic-concurrency revision so concurrent receipts compute correctly. Without a cost the model's current cost is used for the movement values.
- Receiving writes one `receive` movement per (series, size) with sequential before/after values.
- A shipment for an archived model is refused (`MODEL_ARCHIVED`).

### 3.4 Transfers

Move pieces between shop and warehouse, several sizes at once. Source and destination must differ (`SAME_LOCATION`); FIFO from the source; the moved part of a partially used series goes to a **derived** series at the destination while the remainder stays in the origin series. Insufficient stock → `INSUFFICIENT_STOCK` and nothing is changed (no partial effect). Ownership, supplier and agreed consignment price travel with the pieces (derived series inherit them), so transferred consignment goods remain sellable and settleable.

### 3.5 Damage and inventory count

- **Damage:** remove a quantity at a location (FIFO); a reason is mandatory; recorded as `damaged` with cost at the model's current cost. Counts as a USD write-off in Finance.
- **Adjust (جرد):** set the real counted quantity for a size at a location. No difference is an error (`NO_DIFFERENCE`). A decrease is FIFO; an **increase goes to the balance series** (the count does not create a received series). A reason is mandatory.

### 3.6 Sales, prices and flags

- Items are shop stock only. Each invoice line is a **snapshot** (model data, cost, selling price, entered unit price, USD value of the unit price, flag), so history never changes.
- `unitPrice` is in the invoice currency; `unitPriceUsd` = `unitPrice` (USD) or `unitPrice / rate` (SYP). Totals: `totalPaid` (sum of lines), `creditApplied` (return credit, exchange only), `cashDue = totalPaid − creditApplied`, `totalUsd`, `costUsd`, `profitUsd = totalUsd − costUsd`. USD amounts have 2 decimals, SYP are whole pounds.
- Flags: `below_cost` when the USD price is lower than cost, `below_sell_price` when lower than the selling price (with a small tolerance, half a pound in SYP), else `normal`.
- A cash receipt of `cashDue` is posted in the invoice currency in the same atomic unit. A negative `cashDue` (exchange with surplus credit) is a cash **outflow**; a zero `cashDue` posts nothing.

### 3.7 Cancellation

Allowed only for `completed` invoices with no returned quantity that are not exchange invoices. Marks the invoice `cancelled` (conditional update, so it cannot happen twice), restores each line to its original series (`cancel` movement), and reverses the cash receipt with an opposite movement in the same currency. Items whose model or size no longer exists are counted in `notRestocked`.

### 3.8 Returns and exchange

- Return quantity per line is capped by the quantity still returnable and reserved with an atomic conditional update (no double return).
- Condition `good` returns the piece to its original series (movement `return`); `damaged` writes it off (movement `return_damaged`, no series allocation, `writeOffUsd` at cost).
- **Accounting principle:** the returned item reverses at its **original sale values** (price, cost, profit). The replacement is sold at **today's** values in a new invoice. The difference between the refunded amount valued at today's rate and at the original rate is stored as `fxDiffUsd` (owner only).
- **Cash mode:** the refund `refundAmount` is paid out of the cash account of the **original invoice currency** (`customer_refund`).
- **Exchange mode:** requires replacement items; the new invoice **must be in the same currency** as the original (`EXCHANGE_CURRENCY_MISMATCH`; to switch currencies use a cash return and a new sale). The credit is applied to the new invoice (`creditApplied`), and only the difference moves cash. A return on a cancelled invoice is refused (`INVOICE_CANCELLED`). SYP returns need a rate.

### 3.9 Consignment (بضاعة الأمانة)

- Receiving consignment records the physical stock and supplier ownership on the series (`supplier`, `ownership = "consignment"`); derived series inherit them. It **never** creates a payable or a cash movement.
- A payable arises **only from a settlement** for pieces that have actually been sold.
- **Sold quantity** per (series, size) = Σ `sale` − Σ `cancel` − Σ good `return`, taken from stock-movement allocations (customer invoices are never reused as supplier invoices). A **damaged** customer return carries no series allocation and is **not** subtracted automatically (manual reconciliation).
- **Agreed price:** per series, in its **own currency** (USD or SYP), captured at receipt or recorded later; the optional entered exchange rate is documentation only. Changing it needs `adjust: true` plus a reason and appends to the price history (`set` / `adjust`, with previous value, reason and actor). Registering a price for a series that already has one without `adjust`, or adjusting one that has none, is refused. A consignment series **without a price** is never valued from the wholesale cost, cannot be settled, and is flagged.
- A consignment series cannot be attached to an ordinary purchase invoice (`CONSIGNMENT_NOT_PURCHASE`); a series belonging to another supplier is refused.
- Remaining-stock valuation per currency from agreed prices is an estimate, not a ledger figure.

### 3.10 Settlements (تسويات الأمانة)

A settlement turns sold consignment pieces into a supplier liability.

- *Eligible* quantity per (series, size) = net sold − already settled (`settledQty`). A line cannot exceed it (`CONSIGNMENT_OVER_SETTLEMENT`). `settledQty` advances by an **atomic conditional update**, so a piece cannot be settled twice, even by concurrent requests.
- A settlement has **one currency** (the price currency); selecting series priced in different currencies is rejected (`MIXED_CURRENCY_SETTLEMENT`). Line = qty × agreed unit price (integer minor units); total must be positive.
- Posting creates, atomically: a supplier invoice of kind `consignment_settlement` (number = the settlement reference `SST-000001`), a `purchase` ledger entry in that currency, and increments `settledQty`. **No cash movement.**
- **Reversal** posts a reversing ledger entry, releases `settledQty`, marks the settlement `reversed`; the original record stays. It is refused while the settlement's invoice still has live allocations (`REVERSE_PAYMENTS_FIRST`).
- A customer invoice cancelled after its pieces were settled flags the line as **over-settled** (settled > sold); reverse the settlement.
- The request carries an idempotency key; a duplicate returns the first result, an in-flight duplicate answers `SETTLEMENT_IN_PROGRESS`.

### 3.11 Supplier returns (إرجاع للتاجر)

Only the supplier's own consignment series can be returned. Each line is a conditional atomic decrement (never negative, safe under concurrency), writes a `supplier_return` movement (per model, size and location, with before/after) and a `supplier_returns` document (`SRT-000001`) with the **agreed price snapshot** per line and an estimated value per currency; pieces without an agreed price are counted as `unpricedQty` (manual reconciliation). A `return_credit` ledger entry is posted **only when the owner supplies a credit** (amount, currency, optional invoice of the same currency); it reduces what is owed or becomes an available credit and **never moves cash**. The stock movement and the financial entry are separate but linked. Idempotent by key.

### 3.12 Supplier ledger rules

- Entries are **append-only**; each is stored in its original currency with an integer `amountMinor` and signed `signedMinor` (positive increases what the store owes, negative reduces it). Types: `purchase`, `adjustment` (debit; increases the payable), `payment`, `advance`, `credit` (credit note), `return_credit` (all reduce it) and `reversal`.
- **Positions per currency `c`** (never summed across currencies):
  `grossPayable[c] = live invoices + debit adjustments − allocations applied to c-invoices`
  `advance[c] = live credits − credit consumed by allocations`
  `net[c] = grossPayable[c] − advance[c]`
  Status: `settled`, `due` (payable only), `advance` (advance only), `mixed` (any currency has a payable and any has an advance). The net never hides either side. Nothing is stored; positions are recomputed from entries and allocations.
- **Allocation policy.** A payment/credit note/return credit linked to a same-currency invoice at posting is allocated to it immediately (`source: direct`); it cannot exceed the invoice remainder (`INVOICE_OVERPAID`: record the excess as an advance). Advances and unlinked credits stay available until allocated explicitly (`manual`) or by the explicit auto-apply (oldest credit to oldest invoice, **same currency only**, `auto`). Allocation records are append-only; releasing creates a `release` record and marks the original. Allocations **never** create cash movements (the cash left when the payment/advance was paid).
- **Reversal.** A new `reversal` entry with the opposite sign; the original gets one `reversedBy`. Reversing a credit releases its live allocations and, for a payment/advance, reverses its cash movement. Reversing an invoice requires that it have no live allocations. A reversal cannot be reversed (`CANNOT_REVERSE_REVERSAL`). Settlement invoices are reversed through the settlement (`REVERSE_VIA_SETTLEMENT`).
- **Cross-currency payments (explicit policy).** Preferred: pay in the invoice's currency. If the invoice is in one currency and the payment in the other, the request must carry `crossCurrency: { settlesAmount, rate }` — the amount settled in the invoice currency and the exchange rate entered by the user (SYP per 1 USD). Without it: `CROSS_CURRENCY_CONFIRM_REQUIRED`; inconsistent amounts and rate: `RATE_AMOUNT_MISMATCH`. Only the payment currency's cash account decreases by the actual amount; the invoice is reduced by the stated settled amount; the rate is stored on the entry and the allocation. **No exchange gain/loss entry is posted** and no rate is ever invented or read from settings. Credit notes and return credits link only to invoices of the same currency (`CROSS_CURRENCY_NOT_ALLOWED`). Allocating an advance across currencies follows the same rule (`crossCurrency: true`, `amount`, `creditAmount`, `rate`) and never creates cash movement.
- **Valuation snapshots.** Entries may store an explicitly entered `rate` and a derived `valuationUsdMinor` for documentation only; they never feed balances, cash or dashboards.
- A supplier invoice number is unique per supplier (case/space-insensitive, `DUPLICATE_INVOICE`); due date cannot precede the invoice date; invoices and credits can only be recorded for **active** suppliers.

### 3.13 Cash ledger rules

Two independent cash accounts: **صندوق الليرة السورية** and **صندوق الدولار الأمريكي**. They are never added, subtracted, combined or converted into each other anywhere (API, reports, UI).

- `cash_movements` is the **only source of cash balances**: an append-only ledger. Each movement has a `currency`, `direction` (`in`/`out`), integer `amountMinor` (USD cents, whole SYP), `type`, `source` (invoice / return / supplier_entry / expense / manual), date, creator and a deterministic unique `idempotencyKey`. Balance per currency = Σ in − Σ out. Corrections are **new opposite movements** linked by `reverses` / `reversedBy`; nothing is edited or deleted.
- Which events move cash (and only these):

| Event | Cash effect |
|---|---|
| Customer sale (cashier) | **+ `cashDue`** in the invoice currency (a credit applied on an exchange is not cash). A negative `cashDue` is an outflow. |
| Invoice cancellation | Opposite movement of the original receipt, same currency, once. |
| Customer cash return | **− `cashRefund`** in the original invoice currency. |
| Customer exchange | Credit applies only to a new invoice in the same currency; a different currency is rejected. Only the difference moves cash. |
| Supplier payment / advance | **− actual amount** in the payment currency only. |
| Reversal of a supplier payment/advance | + the opposite movement, same currency. |
| Supplier invoice, settlement, credit note, return credit, debit adjustment, allocation / release of an advance | **None** (liabilities and bookkeeping). |
| Expense | − amount in its currency; reversal restores it. |
| Manual deposit / withdrawal (owner) | Opening balances and corrections, note mandatory; reversible. |

- Idempotency keys by source: `sale:<invoiceId>`, `salecancel:<movementId>`, `refund:<returnId>`, `supent:<entryId>`, `supentrev:<movementId>`, `exp:<expenseId>`, `exprev:<movementId>`, `manual:<clientKey>`, `manualrev:<movementId>`. A repeated posting returns the existing movement.
- Money precision: USD = integer cents (at most 2 decimals on input), SYP = whole pounds. All sums are integer sums; floats exist only for display. Every posting validates currency and precision (`INVALID_AMOUNT_PRECISION`).
- Manual movements can be reversed from Finance; movements created by other events must be reversed at their source (`CASH_REVERSE_VIA_SOURCE`). A movement can be reversed once (`CASH_ALREADY_REVERSED`).
- A currency swap between accounts is two manual movements, one in each account (there is no exchange gain/loss entry).

### 3.14 Per-currency Finance formulas

Computed per currency over the chosen period (`from` inclusive, `to` exclusive). No cross-currency figure exists.

| Indicator | Definition |
|---|---|
| Cash balance | Σ in − Σ out over **all time** in that currency's cash movements. |
| Cash in / out / net | Σ of the period's movements by direction; net = in − out (never called profit). |
| Sales revenue | Σ `totalPaid` of **completed** invoices in that currency (cancelled excluded). |
| Refunds | Σ `refundAmount` of returns on invoices of that currency. |
| Net revenue | Sales revenue − refunds. |
| COGS (USD only) | Σ invoice `costUsd` − cost of **good** (restocked) returned items. |
| Gross profit (USD only) | Net revenue − COGS. |
| Operating expenses | Σ posted, non-reversed expenses in that currency. |
| Inventory write-offs (USD only) | Σ cost of `damaged` movements (direct damage; cost is in USD). |
| Net profit (USD only) | Gross profit − expenses − write-offs. |
| Supplier payments | Cash out for supplier payments and advances, minus supplier reversals, in that currency. |
| Supplier payable / advances | Current gross payable / unallocated advances in that currency (supplier accounts). |
| Customer receivables | Not supported (sales are cash) and reported as such. |

**SYP profit is unavailable.** Stock cost is stored in USD and there is no SYP cost basis, so the SYP section shows COGS, gross profit and net profit as «غير متاح» (`null` with an explanation). A separate **estimate** is displayed — cost USD × each invoice's own recorded rate, SYP net revenue minus that, minus expenses (no write-offs) — clearly labelled and never included in any total. SYP revenue, refunds, expenses and cash are exact; only cost-based figures are unavailable.

### 3.15 Currency rules

- Never mix currencies: no total over USD + SYP, no automatic conversion, no cash swap. Every number carries its currency.
- Selling prices of models and costs are in USD. Invoices can be in USD or SYP; an SYP invoice stores the rate used and the USD value of each line for the owner's accounting.
- Cross-currency effects exist only where explicitly confirmed with an entered rate: supplier payments/allocations across currencies, and the display-only price conversion in the cashier.

### 3.16 Idempotency summary

Posting a shipment, supplier invoice/payment/advance/adjustment/allocation, settlement, supplier return, manual cash movement or expense requires an `idempotencyKey` (8–100 characters). The first success returns **201**; a repeat with the same key returns **200** with `duplicate: true` and the original result, and posts nothing. Reusing a key for a different operation or supplier answers `IDEMPOTENCY_MISMATCH`; a request still being processed answers `SHIPMENT_IN_PROGRESS`, `SETTLEMENT_IN_PROGRESS` or `RETURN_IN_PROGRESS`. After a genuine failure the claim is removed so the same key can be retried.

### 3.17 Alert rules

Quantity 1 does **not** alert. Shop 0 and warehouse > 0 → "transfer from the warehouse". Both 0 → "order a shipment". Low-stock alerts were removed.

### 3.18 Payroll rules

- **Calculation (single path, on the server).** `net = base + allowances + bonuses − approved deductions`; `remaining = net − advance settlements applied − salary payments`; the **remaining payable shown and prefilled = remaining − scheduled advance settlement** (what the employee will actually receive). The base is a **snapshot** of the employee's salary when the month's period is created (later salary changes never touch existing periods). All math is integer minor units per currency; USD and SYP are never combined.
- **Automatic monthly periods.** Key `YYYY-MM` (UTC month boundaries). A period is created on demand (unique `{employee, periodKey}` makes this safe under concurrency), starts as `draft` (allowances, bonuses and deductions can be added), and is **approved automatically at the first salary payment**. Statuses: `draft` → `approved` → `partially_paid` → `paid` (derived) → `closed`. Reading a summary never creates a period. A closed period is never reopened or modified by ordinary operations; future months cannot be paid.
- **Eligibility of a month.** No period is created (by a payment, an advance, an adjustment or the API) for a month before the employee's hire month (`BEFORE_HIRE`) or before the month the current salary is known to apply (`salaryEffectiveFrom`; default the month the record was created; set to the current month whenever the salary changes) (`HISTORICAL_SALARY_UNKNOWN`) — the current salary is never used as an invented historical snapshot. Back-dating requires the owner to declare `salaryEffectiveFrom` explicitly on the employee (audited by `updatedBy`); existing periods are never rewritten.
- **One month source.** The server (UTC) decides the current month; the list, summary and forms read `currentKey` from it and never compute the month in the browser.
- **List = account.** The employees list uses the same server summary as the account, so «المتبقي للدفع» is the remaining payable after the scheduled advance deduction in both places, and outstanding advances are shown separately.
- **Default month for a salary payment:** the oldest open month (not closed) that still has a remaining balance up to the current month, otherwise the current month. An explicit month can be passed.
- **Salary payment = a Finance expense.** Category «رواتب» + employee: one atomic unit creates the ledger entry, updates the period counters (conditional update: never above the remaining payable), creates the expense and, for cash, **one** cash movement (`type: expense`) in the register of the employee's currency. Payment outside the register creates the expense and the ledger entry but **no** cash movement. Salary expenses therefore count in the Finance dashboard's operating expenses and net profit like any expense. Reversing the expense (Finance → Expenses, or the statement) reverses the payment entry, the expense and its cash movement together.
- **Advances.** Recorded from the employee account: `issue` = create (pending) + disburse in one step, with one idempotency key. Disbursement is a separate ledger event (`advance_disbursement`), never a salary payment or an entitlement. Disbursed principal stays outstanding until settled.
- **Default deduction month:** the nearest month from the current one that does not exist yet or is open (`draft` / `approved` / `partially_paid`); closed and fully paid months are skipped. It is displayed before confirmation and may be changed to another open month. Moving a disbursed advance later is only the explicit `reassign` action (before any settlement, audited).
- **Automatic settlement and carry-forward.** At the first salary payment of a month (or «apply deduction now», or closing the month) the scheduled advances of that month are settled oldest first, each by `min(outstanding, room left in the salary)`. Anything the salary cannot absorb is **carried to the next eligible month**: the *same* advance row moves its deduction month (no second advance, no new disbursement, no cash), a `carry:` ledger entry (type «ترحيل / إعادة إسناد») records the amount, and each settlement stays a separate ledger entry linked to the advance. Reversing a settlement restores the advance's outstanding amount; it does **not** move the deduction month back (use `reassign` if needed). A month cannot be closed while it has scheduled advances (they are settled or carried first) and must be fully paid.
- **Closed or corrected months.** Settlements, payments and reversals are rejected on a closed month (`PERIOD_CLOSED`); an advance whose month was closed can only be re-pointed with `reassign` to an open month. Corrections to posted entries are always reversal entries.
- **Inactive employees.** If a scheduled advance exceeds the remaining salary and the employee is inactive/terminated, the carry-forward cannot create a new month: the payment/deduction is refused up front (`INACTIVE_ADVANCE_CARRY`), nothing is written, and the advance stays outstanding and visible. **Owner decision needed** on how such advances are settled (reactivate the employee, or an approved manual treatment); the system does not write them off.
- **Salary category.** Spelling variants («الرواتب», «راتب», `salary`…) are the salary category: they require an employee and are stored as «رواتب». Reversing a salary expense requires `payroll.pay` as well as `finance.manage`.
- **Close month is atomic.** Closing = approve (if draft) + settle/carry scheduled advances + checks + close in one unit; a refused or failed close leaves no approval, settlement or entry behind.
- **Overpayment and double processing.** A payment above the remaining payable is rejected (`EXCEEDS_REMAINING`), and with nothing payable `NO_SALARY_DUE`. A key is **bound to its request** (fingerprint of employee, amount, currency, method, month): reuse with different parameters is `IDEMPOTENCY_KEY_REUSED` (409). Keys are deterministic per operation (`salpay:`, `autoset:<advance>:<period>:<n>`, `carry:…`, `advdisb:`, `entrev:`); parallel duplicates collide on the unique ledger key and return the original result or `CONCURRENT_UPDATE` (409, retry).
- **Allowances / bonuses / deductions** can be added or reversed while the month is `draft`, or `approved` with nothing paid or settled yet; after the first payment or settlement they are locked.
- **Legacy payments.** Salary payments recorded before this redesign through the old payroll endpoint have a cash movement of source `payroll_payment` and no expense; they remain valid and reversible, but are not counted in Finance expenses. The old endpoint `POST /payroll-periods/:id/payments` is kept for compatibility but now **delegates to the same service as Finance → Expenses** (so new payments through it are expenses and apply the advance deduction); the manual settlement, approval, reassign and adjustment endpoints remain.
- **Not implemented:** statement export/printing (no export capability exists in the project), payroll for non-monthly schedules, tax/insurance, multi-employee batch payroll, a UI for the low-level period endpoints (they remain available through the API).

