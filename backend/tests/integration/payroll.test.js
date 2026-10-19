/*
 * الرواتب والسلف: سير العمل والمبالغ والنقد والتكرار والتزامن والصلاحيات. تُشغَّل بـ:
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_payroll" بالكامل (اسمها يجب أن يحوي test). تعمل على standalone وعلى Replica Set.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_payroll$2") : RAW;
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const suite = (name, fn) => test(name, { skip }, fn);

let mongoose, server, base, admin, emp;
const call = async (s, method, p, body) => {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(s ? { Cookie: s.cookie, "x-csrf-token": s.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const login = async (username, password) => {
  const res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: username, password }) });
  return { cookie: res.headers.getSetCookie().find((c) => c.startsWith("poplar_sid=")).split(";")[0], csrf: (await res.json()).csrfToken };
};
const A = (m, p, b) => call(admin, m, p, b);
const key = () => crypto.randomUUID();
const { currentKey, addMonths } = require("../../src/utils/payroll");
const CUR = currentKey();
const NEXT = addMonths(CUR, 1);
const PREV = addMonths(CUR, -1);
let n = 0;

// أدوات المجال
const mkEmp = async (o = {}) => (await A("POST", "/employees", { name: `موظف ${++n}`, salary: 1000, currency: "USD", ...o })).json;
const mkPeriod = async (employeeId, periodKey = CUR) => (await A("POST", "/payroll-periods", { employeeId, periodKey })).json.period;
const approve = (id) => A("POST", `/payroll-periods/${id}/approve`, {});
const adjust = (id, kind, amount, extra = {}) => A("POST", `/payroll-periods/${id}/adjustments`, { kind, amount, note: "اختبار", idempotencyKey: key(), ...extra });
const pay = (id, amount, extra = {}) => A("POST", `/payroll-periods/${id}/payments`, { amount, idempotencyKey: key(), ...extra });
const mkAdv = (employeeId, deductionPeriodId, amount, extra = {}) => A("POST", "/employee-advances", { employeeId, deductionPeriodId, amount, idempotencyKey: key(), ...extra });
const disburse = (id, body = {}) => A("POST", `/employee-advances/${id}/disburse`, body);
const settle = (id, amount, extra = {}) => A("POST", `/employee-advances/${id}/settlements`, { amount, idempotencyKey: key(), ...extra });
const period = async (id) => (await A("GET", `/payroll-periods/${id}`)).json;
const advance = async (id) => (await A("GET", `/employee-advances/${id}`)).json.advance;
const cashRows = async (q = "") => (await A("GET", `/finance/cash?limit=100${q}`)).json.items;
const balance = async (cur) => {
  const range = `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5).toISOString())}`;
  return (await A("GET", `/finance/dashboard?${range}`)).json[cur].balance;
};
const ledgerOf = async (employeeId, q = "") => (await A("GET", `/employees/${employeeId}/ledger?limit=100${q}`)).json.items;

test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  const dir = path.join(__dirname, "../../src/models");
  await Promise.all(fs.readdirSync(dir).filter((f) => f.endsWith(".model.js")).map((f) => require(path.join(dir, f)).init?.()));
  const { createApp } = require("../../src/app");
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const { hashPassword } = require("../../src/utils/password");
  await require("../../src/models/user.model").create({ name: "المالك", username: "pay-owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  admin = await login("pay-owner", "Owner-Test-Pass1");
  assert.equal((await A("POST", "/users", { name: "كاشير", username: "pay-clerk", password: "Clerk-Test-Pass1" })).status, 201);
  emp = await login("pay-clerk", "Clerk-Test-Pass1");
  // رصيد افتتاحي في الصندوقين كي لا تتأثر الاختبارات بالرصيد
  await A("POST", "/finance/cash", { currency: "USD", direction: "in", amount: 100000, note: "افتتاحي", idempotencyKey: key() });
  await A("POST", "/finance/cash", { currency: "SYP", direction: "in", amount: 1000000000, note: "افتتاحي", idempotencyKey: key() });
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

// ───────────────────────── الموظف والفترة ─────────────────────────
suite("employee: create, precision rules, link to user account, currency lock", async () => {
  const e = await A("POST", "/employees", { name: "ليلى أحمد", salary: 1000.5, currency: "USD", jobTitle: "بائعة" });
  assert.equal(e.status, 201);
  assert.match(e.json.number, /^EMP-\d{6}$/);
  assert.equal(e.json.salary, 1000.5);
  assert.equal((await A("POST", "/employees", { name: "x1", salary: 1000.555, currency: "USD" })).status, 400);
  assert.equal((await A("POST", "/employees", { name: "x2", salary: 1500000.5, currency: "SYP" })).status, 400);
  assert.equal((await A("POST", "/employees", { name: "x3", salary: -5, currency: "USD" })).status, 400);
  assert.equal((await A("POST", "/employees", { name: "x4", salary: 5, currency: "USD", hacked: 1 })).status, 400);
  // ربط حساب دخول: مرة واحدة فقط ولا يُربط حساب المالك
  const users = (await A("GET", "/users")).json;
  const clerk = (users.items || users).find((u) => u.username === "pay-clerk");
  const linked = await A("PATCH", `/employees/${e.json.id}`, { userId: clerk.id });
  assert.equal(linked.status, 200);
  const other = await mkEmp({ salaryEffectiveFrom: PREV });
  assert.equal((await A("PATCH", `/employees/${other.id}`, { userId: clerk.id })).status, 409);
  // العملة تُقفل بعد أول فترة (فترة الشهر الماضي مسموحة لأن سريان الراتب مُصرَّح به صراحةً)
  const p = await mkPeriod(other.id, PREV);
  assert.ok(p.id);
  assert.equal((await A("PATCH", `/employees/${other.id}`, { currency: "SYP", salary: 1000000 })).status, 409);
  assert.equal((await A("PATCH", `/employees/${other.id}`, { salary: 2000 })).status, 200);
});

suite("period: one per employee+key, salary snapshot, approval posts entitlement, components lock after approval", async () => {
  const e = await mkEmp({ salary: 1000 });
  const first = await A("POST", "/payroll-periods", { employeeId: e.id, periodKey: CUR });
  assert.equal(first.status, 201);
  assert.equal(first.json.period.baseSalary, 1000);
  assert.equal(first.json.period.net, 1000);
  assert.equal((await A("POST", "/payroll-periods", { employeeId: e.id, periodKey: CUR })).status, 409);
  assert.equal((await A("POST", "/payroll-periods", { employeeId: e.id, periodKey: "2026-13" })).status, 400);
  // تغيير الراتب لاحقاً لا يمس اللقطة
  await A("PATCH", `/employees/${e.id}`, { salary: 5000 });
  assert.equal((await period(first.json.period.id)).baseSalary, 1000);
  const id = first.json.period.id;
  // بدل ومكافأة واستقطاع في المسودة
  assert.equal((await adjust(id, "allowance", 100)).status, 201);
  assert.equal((await adjust(id, "bonus", 50)).status, 201);
  assert.equal((await adjust(id, "deduction", 30)).status, 201);
  let p = await period(id);
  assert.equal(p.net, 1120);
  assert.equal(p.remaining, 1120);
  assert.equal(p.status, "draft");
  assert.equal((await pay(id, 10)).status, 409, "لا دفع قبل الاعتماد");
  // استقطاع أكبر من الصافي مرفوض
  assert.equal((await adjust(id, "deduction", 5000)).status, 409);
  const ap = await approve(id);
  assert.equal(ap.status, 200);
  assert.equal(ap.json.period.status, "approved");
  assert.equal((await approve(id)).status, 409, "اعتماد مكرر");
  assert.equal((await adjust(id, "bonus", 10)).status, 201, "بعد الاعتماد وقبل أول دفعة يُسمح بالتعديل");
  await pay(id, 100);
  assert.equal((await adjust(id, "bonus", 10)).status, 409, "لا تعديل مكوّنات بعد أول دفعة");
  const types = (await ledgerOf(e.id)).map((l) => l.type).sort();
  assert.deepEqual(types, ["allowance", "bonus", "bonus", "deduction", "salary_entitlement", "salary_payment"]);
});

// ───────────────────────── السلف ─────────────────────────
suite("advance: deduction period is mandatory and validated; creating does not move cash", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  const before = await balance("USD");
  assert.equal((await A("POST", "/employee-advances", { employeeId: e.id, amount: 200, idempotencyKey: key() })).status, 400, "فترة الخصم إلزامية");
  const a = await mkAdv(e.id, p.id, 200);
  assert.equal(a.status, 201);
  assert.equal(a.json.advance.status, "pending");
  assert.equal(a.json.advance.deductionPeriodKey, CUR);
  assert.equal(await balance("USD"), before, "الإنشاء لا يصرف مالاً");
  // موظف آخر وعملة أخرى
  const e2 = await mkEmp({ salary: 1000 });
  const p2 = await mkPeriod(e2.id);
  assert.equal((await mkAdv(e.id, p2.id, 50)).status, 400, "فترة موظف آخر");
  assert.equal((await mkAdv(e.id, p.id, 50, { currency: "SYP" })).status, 400, "عملة مخالفة");
  assert.equal((await mkAdv(e.id, p.id, 50.555)).status, 400, "دقة المبلغ");
  const eSyp = await mkEmp({ salary: 3000000, currency: "SYP" });
  const pSyp = await mkPeriod(eSyp.id);
  assert.equal((await mkAdv(e.id, pSyp.id, 50)).status, 400, "فترة بعملة أخرى");
  // لا إسناد إلى فترة مغلقة/مدفوعة
  const e3 = await mkEmp({ salary: 100 });
  const p3 = await mkPeriod(e3.id);
  await approve(p3.id);
  await pay(p3.id, 100);
  assert.equal((await mkAdv(e3.id, p3.id, 10)).status, 409, "فترة مدفوعة بالكامل");
  // إعادة الطلب بنفس المفتاح
  const k = key();
  const one = await mkAdv(e.id, p.id, 75, { idempotencyKey: k });
  const two = await mkAdv(e.id, p.id, 75, { idempotencyKey: k });
  assert.equal(one.status, 201);
  assert.equal(two.status, 200);
  assert.equal(two.json.advance.id, one.json.advance.id);
});

suite("advance: cash disbursement creates one real cash-out in the right register; other creates none; disbursed twice is harmless", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  const a = (await mkAdv(e.id, p.id, 200)).json.advance;
  assert.equal((await settle(a.id, 10)).status, 409, "لا تسوية قبل الصرف");
  const usd0 = await balance("USD");
  const syp0 = await balance("SYP");
  const d = await disburse(a.id, { method: "cash" });
  assert.equal(d.status, 201);
  assert.equal(d.json.advance.status, "disbursed");
  assert.equal(await balance("USD"), usd0 - 200);
  assert.equal(await balance("SYP"), syp0, "صندوق الليرة لا يتأثر");
  const mv = (await cashRows()).filter((m) => m.type === "employee_advance");
  assert.equal(mv.length >= 1, true);
  assert.ok(mv.some((m) => m.currency === "USD" && m.direction === "out" && m.amount === 200 && m.source.ref === a.ref));
  const again = await disburse(a.id, { method: "cash" });
  assert.equal(again.status, 200);
  assert.equal(await balance("USD"), usd0 - 200, "صرف مكرر لا يخرج مالاً");
  // دفعة صرف خارج الصندوق: لا حركة نقد
  const b = (await mkAdv(e.id, p.id, 40)).json.advance;
  const usd1 = await balance("USD");
  assert.equal((await disburse(b.id, { method: "other" })).status, 201);
  assert.equal(await balance("USD"), usd1);
  assert.ok(!(await cashRows()).some((m) => m.source.ref === b.ref));
});

suite("payroll math: net, advance settlement vs payment, partial/full payment, overpayment rejected, cash out per payment", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  await adjust(p.id, "allowance", 100);
  await adjust(p.id, "bonus", 50);
  await adjust(p.id, "deduction", 30);
  await approve(p.id);
  const a = (await mkAdv(e.id, p.id, 200)).json.advance;
  await disburse(a.id);
  // صرف السلفة وحده لا يخفض المتبقي (لا خصم مزدوج)
  assert.equal((await period(p.id)).remaining, 1120);
  const s = await settle(a.id, 200);
  assert.equal(s.status, 201);
  assert.equal(s.json.period.advanceSettlements, 200);
  assert.equal(s.json.period.remaining, 920);
  assert.equal(s.json.advance.status, "settled");
  assert.equal(s.json.advance.outstanding, 0);
  const usd0 = await balance("USD");
  const p1 = await pay(p.id, 500);
  assert.equal(p1.status, 201);
  assert.equal(p1.json.period.status, "partially_paid");
  assert.equal(p1.json.period.remaining, 420);
  assert.equal(await balance("USD"), usd0 - 500);
  assert.equal((await pay(p.id, 420.01)).status, 409, "تجاوز المتبقي");
  assert.equal((await pay(p.id, 420.001)).status, 400, "دقة المبلغ");
  assert.equal((await pay(p.id, 100, { currency: "SYP" })).status, 400, "عملة مخالفة");
  const p2 = await pay(p.id, 420);
  assert.equal(p2.json.period.status, "paid");
  assert.equal(p2.json.period.remaining, 0);
  assert.equal(await balance("USD"), usd0 - 920);
  assert.equal((await pay(p.id, 1)).status, 409, "لا دفع بعد السداد");
  // دفتر الموظف يطابق عدّادات الفترة (المرجع الوحيد)
  const posted = (await ledgerOf(e.id)).filter((l) => l.state === "posted");
  const sum = (t) => posted.filter((l) => l.type === t).reduce((x, l) => x + l.amount, 0);
  const fin = await period(p.id);
  assert.equal(sum("allowance"), fin.allowances);
  assert.equal(sum("bonus"), fin.bonuses);
  assert.equal(sum("deduction"), fin.deductions);
  assert.equal(sum("advance_settlement"), fin.advanceSettlements);
  assert.equal(sum("salary_payment"), fin.paid);
  assert.equal(sum("salary_entitlement") + fin.allowances + fin.bonuses - fin.deductions, fin.net);
  // إغلاق: فقط المدفوعة بالكامل ولا سلف مفتوحة
  const closed = await A("POST", `/payroll-periods/${p.id}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal(closed.json.period.status, "closed");
  assert.equal((await pay(p.id, 1)).status, 409);
  assert.equal((await adjust(p.id, "bonus", 1)).status, 409);
  assert.equal((await A("POST", `/payroll-periods/${p.id}/close`, {})).status, 409);
});

suite("settlement rules: assigned period only, no over-settlement, advance cannot exceed net, cross-employee blocked", async () => {
  const e = await mkEmp({ salary: 100 });
  const p = await mkPeriod(e.id);
  await approve(p.id);
  const a = (await mkAdv(e.id, p.id, 150)).json.advance; // السلفة أكبر من الراتب
  await disburse(a.id);
  assert.equal((await settle(a.id, 151)).status, 409, "يتجاوز المتبقي من السلفة");
  assert.equal((await settle(a.id, 120)).status, 409, "يتجاوز صافي الراتب");
  assert.equal((await settle(a.id, 100)).status, 201);
  const adv = await advance(a.id);
  assert.equal(adv.status, "partially_settled");
  assert.equal(adv.outstanding, 50);
  assert.equal((await period(p.id)).status, "paid", "الراتب سُدِّد بالتسوية");
  assert.equal((await settle(a.id, 60)).status, 409, "يتجاوز المتبقي");
  // إغلاق فترة عليها سلفة مفتوحة مرفوض حتى تُسوّى أو تُنقل
  const close = await A("POST", `/payroll-periods/${p.id}/close`, {});
  assert.equal(close.status, 409);
  assert.equal(close.json.code, "ADVANCES_OPEN");
  // الفترة التالية: إعادة الإسناد ممنوعة بعد وجود تسوية
  const next = await mkPeriod(e.id, NEXT);
  assert.equal((await A("POST", `/employee-advances/${a.id}/reassign`, { periodId: next.id, reason: "اختبار", idempotencyKey: key() })).status, 409);
});

suite("reassign: explicit, authorized, only before settlement, same employee/currency, audited", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p1 = await mkPeriod(e.id, CUR);
  const p2 = await mkPeriod(e.id, NEXT);
  const other = await mkEmp({ salary: 1000 });
  const po = await mkPeriod(other.id, NEXT);
  const a = (await mkAdv(e.id, p1.id, 100)).json.advance;
  await disburse(a.id);
  assert.equal((await A("POST", `/employee-advances/${a.id}/reassign`, { periodId: po.id, reason: "خطأ", idempotencyKey: key() })).status, 400, "فترة موظف آخر");
  assert.equal((await A("POST", `/employee-advances/${a.id}/reassign`, { periodId: p1.id, reason: "نفسها", idempotencyKey: key() })).status, 400);
  const k = key();
  const r = await A("POST", `/employee-advances/${a.id}/reassign`, { periodId: p2.id, reason: "تأجيل الخصم", idempotencyKey: k });
  assert.equal(r.status, 201);
  assert.equal(r.json.advance.deductionPeriodKey, NEXT);
  assert.equal((await A("POST", `/employee-advances/${a.id}/reassign`, { periodId: p2.id, reason: "تأجيل الخصم", idempotencyKey: k })).status, 200, "إعادة بنفس المفتاح");
  assert.ok((await ledgerOf(e.id)).some((l) => l.type === "adjustment" && l.advanceId === a.id));
  // التسوية تذهب لفترة الخصم الجديدة فقط
  await approve(p2.id);
  const s = await settle(a.id, 100);
  assert.equal(s.json.period.periodKey, NEXT);
  assert.equal((await period(p1.id)).advanceSettlements, 0);
});

// ───────────────────────── العكس والسلامة ─────────────────────────
suite("reversals: payment (cash too), settlement, advance; history kept; double reversal rejected; closed period locked", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  await approve(p.id);
  const pn = await mkPeriod(e.id, NEXT);
  const a = (await mkAdv(e.id, pn.id, 300)).json.advance; // مجدولة للشهر القادم: دفعة هذا الشهر لا تُسوّيها تلقائياً
  await disburse(a.id);
  const usdStart = await balance("USD");
  const pm = await pay(p.id, 400);
  const entryId = pm.json.entry.id;
  assert.equal(await balance("USD"), usdStart - 400);
  const rv = await A("POST", `/payroll-periods/${p.id}/payments/${entryId}/reverse`, { reason: "خطأ إدخال" });
  assert.equal(rv.status, 201);
  assert.equal(rv.json.period.paid, 0);
  assert.equal(rv.json.period.status, "approved");
  assert.equal(await balance("USD"), usdStart, "عُكست حركة النقد");
  assert.equal((await A("POST", `/payroll-periods/${p.id}/payments/${entryId}/reverse`, { reason: "مرة ثانية" })).status, 409);
  const led = await ledgerOf(e.id);
  assert.ok(led.some((l) => l.id === entryId && l.state === "reversed"), "القيد الأصلي باقٍ موسوماً");
  assert.ok(led.some((l) => l.type === "reversal" && l.reverses === entryId));
  assert.ok((await cashRows()).some((m) => m.type === "expense_reversal"), "عكس الدفعة يعكس المصروف وحركته النقدية");
  // تسوية ثم عكسها
  const st = await settle(a.id, 100);
  assert.equal(st.json.advance.outstanding, 200);
  const undo = await A("POST", `/employee-advances/${a.id}/settlements/${st.json.entry.id}/reverse`, { reason: "تصحيح" });
  assert.equal(undo.status, 201);
  assert.equal(undo.json.advance.outstanding, 300);
  assert.equal(undo.json.advance.status, "disbursed");
  assert.equal(undo.json.period.advanceSettlements, 0);
  // عكس سلفة مصروفة: يعيد النقد؛ ولا يُسمح مع وجود تسوية
  await settle(a.id, 50);
  assert.equal((await A("POST", `/employee-advances/${a.id}/reversals`, { reason: "x" })).json.code, "HAS_SETTLEMENTS");
  const settled = (await ledgerOf(e.id, "&type=advance_settlement&state=posted"))[0];
  await A("POST", `/employee-advances/${a.id}/settlements/${settled.id}/reverse`, { reason: "تمهيد" });
  const bal = await balance("USD");
  const rev = await A("POST", `/employee-advances/${a.id}/reversals`, { reason: "إلغاء السلفة" });
  assert.equal(rev.status, 201);
  assert.equal(rev.json.advance.status, "reversed");
  assert.equal(await balance("USD"), bal + 300);
  assert.equal((await A("POST", `/employee-advances/${a.id}/reversals`, { reason: "ثانية" })).status, 409);
  assert.equal((await settle(a.id, 1)).status, 409);
  // سلفة لم تُصرف: إلغاء بلا حركة نقد
  const c = (await mkAdv(e.id, p.id, 20)).json.advance;
  const bal2 = await balance("USD");
  const canc = await A("POST", `/employee-advances/${c.id}/reversals`, { reason: "لم تعد مطلوبة" });
  assert.equal(canc.json.advance.status, "cancelled");
  assert.equal(await balance("USD"), bal2);
  // فترة مغلقة: لا عكس عادي
  const e2 = await mkEmp({ salary: 100 });
  const p2 = await mkPeriod(e2.id);
  await approve(p2.id);
  const paid = await pay(p2.id, 100);
  await A("POST", `/payroll-periods/${p2.id}/close`, {});
  assert.equal((await A("POST", `/payroll-periods/${p2.id}/payments/${paid.json.entry.id}/reverse`, { reason: "بعد الإغلاق" })).status, 409);
});

suite("atomicity: a failed cash posting leaves no ledger entry, no counter change", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  await approve(p.id);
  const cashRepo = require("../../src/repositories/cash.repository");
  const original = cashRepo.create;
  cashRepo.create = async () => { throw new Error("boom"); };
  let res;
  try { res = await pay(p.id, 100); } finally { cashRepo.create = original; }
  assert.equal(res.status, 500);
  const after = await period(p.id);
  assert.equal(after.paid, 0);
  assert.equal(after.remaining, 1000);
  assert.ok(!(await ledgerOf(e.id)).some((l) => l.type === "salary_payment"));
  // الطلب نفسه ينجح بعد زوال العطل (المفتاح لم يُستهلك)
  assert.equal((await pay(p.id, 100)).status, 201);
});

// ───────────────────────── التكرار والتزامن ─────────────────────────
suite("idempotency: same key repeats are single-effect for payment, adjustment, settlement", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  const k1 = key();
  assert.equal((await adjust(p.id, "bonus", 10, { idempotencyKey: k1 })).status, 201);
  assert.equal((await adjust(p.id, "bonus", 10, { idempotencyKey: k1 })).status, 200);
  assert.equal((await period(p.id)).bonuses, 10);
  await approve(p.id);
  const usd0 = await balance("USD");
  const k2 = key();
  const first = await pay(p.id, 100, { idempotencyKey: k2 });
  const second = await pay(p.id, 100, { idempotencyKey: k2 });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.entry.id, first.json.entry.id);
  assert.equal(await balance("USD"), usd0 - 100);
  const a = (await mkAdv(e.id, p.id, 100)).json.advance;
  await disburse(a.id);
  const k3 = key();
  assert.equal((await settle(a.id, 40, { idempotencyKey: k3 })).status, 201);
  assert.equal((await settle(a.id, 40, { idempotencyKey: k3 })).status, 200);
  assert.equal((await advance(a.id)).settled, 40);
});

suite("concurrency: duplicate key / over-payment / double settlement / double disbursement under parallel requests", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  await approve(p.id);
  const usd0 = await balance("USD");
  // نفس المفتاح 8 مرات بالتوازي: أثر واحد
  const k = key();
  const same = await Promise.all(Array.from({ length: 8 }, () => pay(p.id, 100, { idempotencyKey: k })));
  assert.equal(same.filter((r) => r.status === 201).length, 1, JSON.stringify(same.map((r) => r.status)));
  assert.ok(same.every((r) => [200, 201, 409].includes(r.status)), "تكرار المفتاح: أصل أو إعادة (200) أو قيد التنفيذ (409 أعد المحاولة)");
  assert.equal((await period(p.id)).paid, 100);
  assert.equal(await balance("USD"), usd0 - 100);
  // مفاتيح مختلفة، كل مبلغ أكبر من نصف المتبقي (900): نجاح واحد فقط
  const race = await Promise.all(Array.from({ length: 6 }, () => pay(p.id, 600)));
  assert.equal(race.filter((r) => r.status === 201).length, 1, JSON.stringify(race.map((r) => r.status)));
  assert.equal((await period(p.id)).paid, 700);
  assert.equal((await period(p.id)).remaining, 300);
  assert.equal(await balance("USD"), usd0 - 700);
  assert.equal((await cashRows("&type=expense")).filter((m) => m.note.includes(e.name)).length, 2);
  // تسوية: المتبقي من السلفة 100، ستة طلبات بـ 60 بمفاتيح مختلفة: نجاح واحد
  const a = (await mkAdv(e.id, p.id, 100)).json.advance;
  await disburse(a.id);
  const sets = await Promise.all(Array.from({ length: 6 }, () => settle(a.id, 60)));
  assert.equal(sets.filter((r) => r.status === 201).length, 1, JSON.stringify(sets.map((r) => r.status)));
  assert.equal((await advance(a.id)).settled, 60);
  assert.equal((await period(p.id)).advanceSettlements, 60);
  // صرف السلفة بالتوازي: حركة نقد واحدة
  const b = (await mkAdv(e.id, p.id, 30)).json.advance;
  const usd1 = await balance("USD");
  const ds = await Promise.all(Array.from({ length: 5 }, () => disburse(b.id)));
  assert.equal(ds.filter((r) => r.status === 201).length, 1, JSON.stringify(ds.map((r) => r.status)));
  assert.equal(await balance("USD"), usd1 - 30);
  assert.equal((await cashRows()).filter((m) => m.source.ref === b.ref).length, 1);
});

// ───────────────────────── الصلاحيات ─────────────────────────
suite("RBAC: employee accounts and anonymous callers cannot touch any payroll endpoint", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = await mkPeriod(e.id);
  await approve(p.id);
  const a = (await mkAdv(e.id, p.id, 10)).json.advance;
  const id = "000000000000000000000001";
  const calls = [
    ["GET", "/employees"], ["POST", "/employees", { name: "x", salary: 1, currency: "USD" }], ["GET", `/employees/${e.id}`], ["PATCH", `/employees/${e.id}`, { salary: 9 }],
    ["GET", `/employees/${e.id}/account`], ["GET", `/employees/${e.id}/payroll-periods`], ["GET", `/employees/${e.id}/ledger`],
    ["POST", "/payroll-periods", { employeeId: e.id, periodKey: "2030-01" }], ["GET", `/payroll-periods/${p.id}`], ["GET", `/payroll-periods/${p.id}/summary`],
    ["POST", `/payroll-periods/${p.id}/adjustments`, { kind: "bonus", amount: 1, note: "x", idempotencyKey: key() }], ["POST", `/payroll-periods/${p.id}/adjustments/${id}/reverse`, { reason: "x" }],
    ["POST", `/payroll-periods/${p.id}/approve`, {}], ["POST", `/payroll-periods/${p.id}/payments`, { amount: 1, idempotencyKey: key() }],
    ["POST", `/payroll-periods/${p.id}/payments/${id}/reverse`, { reason: "x" }], ["POST", `/payroll-periods/${p.id}/close`, {}],
    ["GET", "/employee-advances"], ["POST", "/employee-advances", { employeeId: e.id, deductionPeriodId: p.id, amount: 1, idempotencyKey: key() }], ["GET", `/employee-advances/${a.id}`],
    ["POST", `/employee-advances/${a.id}/disburse`, {}], ["POST", `/employee-advances/${a.id}/settlements`, { amount: 1, idempotencyKey: key() }],
    ["POST", `/employee-advances/${a.id}/settlements/${id}/reverse`, { reason: "x" }], ["POST", `/employee-advances/${a.id}/reversals`, { reason: "x" }],
    ["POST", `/employee-advances/${a.id}/reassign`, { periodId: p.id, reason: "x", idempotencyKey: key() }],
  ];
  for (const [m, u, b] of calls) {
    assert.equal((await call(emp, m, u, b)).status, 403, `employee ${m} ${u}`);
    assert.equal((await call(null, m, u, b)).status, 401, `anonymous ${m} ${u}`);
  }
  // لم يتغير شيء
  assert.equal((await advance(a.id)).status, "pending");
  assert.equal((await period(p.id)).paid, 0);
  assert.equal((await A("GET", `/employees/${e.id}`)).json.salary, 1000);
});

suite("RBAC: new permissions are registered and owner-only (cannot be granted to an employee)", async () => {
  const { PERMISSIONS, GRANTABLE, ADMIN_ONLY, effectivePermissions } = require("../../src/config/permissions");
  const names = ["employees.read", "employees.manage", "payroll.read", "payroll.manage", "payroll.approve", "payroll.pay", "advances.read", "advances.manage", "advances.reverse"];
  for (const p of names) { assert.ok(PERMISSIONS.includes(p), p); assert.ok(ADMIN_ONLY.includes(p), p); assert.ok(!GRANTABLE.includes(p), p); }
  assert.ok(names.every((p) => effectivePermissions({ role: "admin" }).includes(p)));
  assert.ok(!names.some((p) => effectivePermissions({ role: "employee", permissions: names }).includes(p)));
});

suite("employee list: search, filters, period summary, indicators, pagination, no N+1 shape", async () => {
  const tag = `بحث${++n}`;
  const a = await mkEmp({ name: `${tag} علي`, salary: 500 });
  const b = await mkEmp({ name: `${tag} سارة`, salary: 700, status: "inactive" });
  const pa = await mkPeriod(a.id, CUR);
  await approve(pa.id);
  await pay(pa.id, 200);
  const adv = (await mkAdv(a.id, pa.id, 50)).json.advance;
  await disburse(adv.id);
  const list = await A("GET", `/employees?q=${encodeURIComponent(tag)}&periodKey=${CUR}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 2);
  const row = list.json.items.find((x) => x.id === a.id);
  assert.equal(row.period.net, 500);
  assert.equal(row.period.paid, 200);
  assert.equal(row.period.remaining, 300);
  assert.equal(row.advancesOutstanding, 50);
  assert.equal(row.currency, "USD");
  assert.ok(["partially_paid", "overdue"].includes(row.indicator), row.indicator);
  assert.equal(list.json.items.find((x) => x.id === b.id).period, null);
  assert.equal((await A("GET", `/employees?q=${encodeURIComponent(tag)}&status=inactive`)).json.total, 1);
  assert.equal((await A("GET", `/employees?q=${a.number}`)).json.items[0].id, a.id, "بحث بالرقم");
  const paged = await A("GET", `/employees?q=${encodeURIComponent(tag)}&limit=1&page=2`);
  assert.equal(paged.json.items.length, 1);
  assert.equal(paged.json.pages, 2);
  assert.equal((await A("GET", "/employees?limit=1000")).status, 400);
  const acct = (await A("GET", `/employees/${a.id}/account?period=${CUR}`)).json;
  assert.equal(acct.period.remaining, 300);
  assert.equal(acct.periodAdvances.length, 1);
  assert.equal(acct.outstandingAdvances[0].deductionPeriodKey, CUR);
  assert.equal(acct.totals.advancesOutstanding, 50);
  const none = (await A("GET", `/employees/${a.id}/account?period=2030-05`)).json;
  assert.equal(none.period, null, "فترة بلا بيانات لا تُخلط بغيرها");
});

suite("SYP employee: whole pounds, own register only", async () => {
  const e = await mkEmp({ salary: 3000000, currency: "SYP" });
  const p = await mkPeriod(e.id, CUR);
  await approve(p.id);
  const usd0 = await balance("USD");
  const syp0 = await balance("SYP");
  assert.equal((await pay(p.id, 1000.5)).status, 400);
  const r = await pay(p.id, 1000000);
  assert.equal(r.status, 201);
  assert.equal(r.json.period.currency, "SYP");
  assert.equal(r.json.period.remaining, 2000000);
  assert.equal(await balance("SYP"), syp0 - 1000000);
  assert.equal(await balance("USD"), usd0);
});
