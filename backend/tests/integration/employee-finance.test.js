/*
 * واجهة الموظف المالية الموحّدة: دفع الراتب عبر المصروفات، تسجيل السلفة من حساب الموظف، الفترات التلقائية، التسوية والترحيل.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_empfin" بالكامل (اسمها يجب أن يحوي test). تعمل على standalone وعلى Replica Set.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_empfin$2") : RAW;
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

const mkEmp = async (o = {}) => (await A("POST", "/employees", { name: `موظف مالي ${++n}`, salary: 1000, currency: "USD", ...o })).json;
const summary = async (id, period) => (await A("GET", `/employees/${id}/payroll-summary${period ? `?period=${period}` : ""}`)).json;
const salaryExp = (employeeId, amount, extra = {}) => A("POST", "/finance/expenses", { currency: "USD", amount, category: "رواتب", employeeId, idempotencyKey: key(), ...extra });
const issue = (employeeId, amount, extra = {}) => A("POST", "/employee-advances/issue", { employeeId, amount, idempotencyKey: key(), ...extra });
const cashRows = async () => (await A("GET", "/finance/cash?limit=100")).json.items;
const balance = async (cur) => {
  const range = `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5 * 40).toISOString())}`;
  return (await A("GET", `/finance/dashboard?${range}`)).json[cur].balance;
};
const dashExpenses = async (cur) => {
  const range = `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5 * 40).toISOString())}`;
  return (await A("GET", `/finance/dashboard?${range}`)).json[cur].expenses;
};
const ledgerOf = async (id, q = "") => (await A("GET", `/employees/${id}/ledger?limit=100${q}`)).json.items;

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
  await require("../../src/models/user.model").create({ name: "المالك", username: "ef-owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  admin = await login("ef-owner", "Owner-Test-Pass1");
  assert.equal((await A("POST", "/users", { name: "كاشير", username: "ef-clerk", password: "Clerk-Test-Pass1" })).status, 201);
  emp = await login("ef-clerk", "Clerk-Test-Pass1");
  await A("POST", "/finance/cash", { currency: "USD", direction: "in", amount: 100000, note: "افتتاحي", idempotencyKey: key() });
  await A("POST", "/finance/cash", { currency: "SYP", direction: "in", amount: 1000000000, note: "افتتاحي", idempotencyKey: key() });
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

suite("summary: authoritative, works before any period exists, no period is created by reading", async () => {
  const e = await mkEmp({ salary: 700 });
  const s = await summary(e.id);
  assert.equal(s.periodKey, CUR);
  assert.equal(s.periodExists, false);
  assert.equal(s.entitlement, 700);
  assert.equal(s.remainingPayable, 700);
  assert.equal(s.canPay, true);
  assert.equal(s.currency, "USD");
  assert.equal(s.defaultAdvancePeriodKey, CUR);
  assert.equal((await A("GET", `/employees/${e.id}/payroll-periods`)).json.total, 0, "القراءة لا تنشئ فترة");
  const future = await summary(e.id, NEXT);
  assert.equal(future.canPay, false);
  assert.equal(future.reason, "FUTURE_PERIOD");
  assert.equal((await A("GET", `/employees/${e.id}/payroll-summary?period=2026-13`)).status, 400);
});

suite("salary expense: auto period, partial payments, one expense + one cash movement, ledger and summary agree", async () => {
  const e = await mkEmp({ salary: 1000 });
  const bal0 = await balance("USD");
  const exp0 = await dashExpenses("USD");
  const r1 = await salaryExp(e.id, 400);
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.equal(r1.json.expense.category, "رواتب");
  assert.equal(r1.json.expense.employeeId, e.id);
  assert.equal(r1.json.summary.paid, 400);
  assert.equal(r1.json.summary.remainingPayable, 600);
  assert.equal(r1.json.summary.status, "partially_paid");
  assert.equal(await balance("USD"), bal0 - 400);
  assert.equal(await dashExpenses("USD"), exp0 + 400, "الراتب يدخل في مصروفات المالية");
  const mv = (await cashRows()).filter((m) => m.source.ref === r1.json.expense.ref);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].type, "expense");
  assert.equal(mv[0].direction, "out");
  assert.equal(mv[0].amount, 400);
  const led = (await ledgerOf(e.id)).filter((l) => l.type === "salary_payment");
  assert.equal(led.length, 1);
  assert.equal(led[0].expenseId, r1.json.expense.id);
  assert.equal(led[0].cashId !== null, true);
  // الاعتماد تلقائي: لا حاجة لإنشاء/اعتماد فترة يدوياً
  assert.equal((await A("GET", `/employees/${e.id}/payroll-periods`)).json.items[0].status, "partially_paid");
  assert.equal((await salaryExp(e.id, 600.01)).status, 409, "تجاوز المتبقي");
  assert.equal((await salaryExp(e.id, 100.555)).status, 400, "دقة المبلغ");
  assert.equal((await salaryExp(e.id, 0)).status, 400);
  const r2 = await salaryExp(e.id, 600);
  assert.equal(r2.status, 201);
  assert.equal(r2.json.summary.status, "paid");
  const again = await summary(e.id);
  assert.equal(again.canPay, false);
  assert.equal(again.reason, "NO_SALARY_DUE");
  const r3 = await salaryExp(e.id, 1);
  assert.equal(r3.status, 409);
  assert.equal(r3.json.code, "NO_SALARY_DUE");
  // المصروف يظهر في قائمة المصروفات العادية
  const list = (await A("GET", "/finance/expenses?limit=100")).json.items.filter((x) => x.employeeId === e.id);
  assert.equal(list.length, 2);
});

suite("salary expense validation: employee only for the salary category, currency and period rules", async () => {
  const e = await mkEmp({ salary: 500 });
  assert.equal((await A("POST", "/finance/expenses", { currency: "USD", amount: 10, category: "رواتب", idempotencyKey: key() })).json.code, "EMPLOYEE_REQUIRED");
  assert.equal((await A("POST", "/finance/expenses", { currency: "USD", amount: 10, category: "إيجار", employeeId: e.id, idempotencyKey: key() })).json.code, "EMPLOYEE_ONLY_FOR_SALARY");
  assert.equal((await salaryExp(e.id, 10, { currency: "SYP" })).json.code, "CURRENCY_MISMATCH");
  assert.equal((await salaryExp(e.id, 10, { periodKey: NEXT })).json.code, "FUTURE_PERIOD");
  assert.equal((await salaryExp("000000000000000000000001", 10)).status, 404);
  // مصروف عادي لا يتأثر
  const ord = await A("POST", "/finance/expenses", { currency: "USD", amount: 15, category: "كهرباء وماء", idempotencyKey: key() });
  assert.equal(ord.status, 201);
  assert.equal(ord.json.expense.employeeId, null);
});

suite("non-cash salary payment: expense and ledger recorded, no cash movement", async () => {
  const e = await mkEmp({ salary: 300 });
  const bal0 = await balance("USD");
  const r = await salaryExp(e.id, 300, { method: "other" });
  assert.equal(r.status, 201);
  assert.equal(r.json.expense.method, "other");
  assert.equal(await balance("USD"), bal0, "لا حركة نقد وهمية");
  assert.ok(!(await cashRows()).some((m) => m.source.ref === r.json.expense.ref));
  assert.equal(r.json.summary.status, "paid");
  const led = (await ledgerOf(e.id)).find((l) => l.type === "salary_payment");
  assert.equal(led.cashId, null);
  assert.equal(led.expenseId, r.json.expense.id);
});

suite("idempotency and concurrency of salary expenses", async () => {
  const e = await mkEmp({ salary: 1000 });
  const bal0 = await balance("USD");
  const k = key();
  const same = await Promise.all(Array.from({ length: 8 }, () => salaryExp(e.id, 100, { idempotencyKey: k })));
  assert.equal(same.filter((r) => r.status === 201).length, 1, JSON.stringify(same.map((r) => r.status)));
  assert.ok(same.every((r) => [200, 201, 409].includes(r.status)));
  assert.equal((await summary(e.id)).paid, 100);
  assert.equal(await balance("USD"), bal0 - 100);
  assert.equal((await A("GET", "/finance/expenses?limit=100")).json.items.filter((x) => x.employeeId === e.id).length, 1, "مصروف واحد فقط");
  const retry = await salaryExp(e.id, 100, { idempotencyKey: k });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  // سباق: كل طلب أكبر من نصف المتبقي (900) فينجح واحد فقط
  const race = await Promise.all(Array.from({ length: 6 }, () => salaryExp(e.id, 600)));
  assert.equal(race.filter((r) => r.status === 201).length, 1, JSON.stringify(race.map((r) => r.status)));
  assert.equal((await summary(e.id)).paid, 700);
  assert.equal(await balance("USD"), bal0 - 700);
});

suite("advance: one-step issue from the employee account, default deduction period, real cash-out", async () => {
  const e = await mkEmp({ salary: 1000 });
  const bal0 = await balance("USD");
  const r = await issue(e.id, 200);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.advance.status, "disbursed");
  assert.equal(r.json.advance.deductionPeriodKey, CUR);
  assert.equal(r.json.deductionPeriodKey, CUR);
  assert.equal(await balance("USD"), bal0 - 200);
  const mv = (await cashRows()).filter((m) => m.source.ref === r.json.advance.ref);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].type, "employee_advance");
  const s = await summary(e.id);
  assert.equal(s.advances.outstanding, 200);
  assert.equal(s.advances.scheduledInPeriod, 200);
  assert.equal(s.scheduledSettlement, 200);
  assert.equal(s.remainingPayable, 800, "الخصم المجدول لا يُخصم مرتين");
  assert.equal(s.entitlement, 1000, "السلفة ليست استحقاقاً إضافياً ولا تغيّر صافي الراتب");
  // إعادة الطلب بالمفتاح نفسه: لا صرف ثانٍ
  const k = key();
  const a = await issue(e.id, 50, { idempotencyKey: k });
  const b = await issue(e.id, 50, { idempotencyKey: k });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.advance.id, a.json.advance.id);
  assert.equal(await balance("USD"), bal0 - 250);
  // بالتوازي بمفتاح واحد: صرف واحد
  const k2 = key();
  const par = await Promise.all(Array.from({ length: 5 }, () => issue(e.id, 10, { idempotencyKey: k2 })));
  assert.equal(par.filter((x) => x.status === 201).length, 1, JSON.stringify(par.map((x) => x.status)));
  assert.equal(await balance("USD"), bal0 - 260);
  // دفع غير نقدي: لا حركة نقد
  const bal1 = await balance("USD");
  const o = await issue(e.id, 5, { method: "other" });
  assert.equal(o.status, 201);
  assert.equal(await balance("USD"), bal1);
  // تحققات
  assert.equal((await issue(e.id, 5, { currency: "SYP" })).status, 400);
  assert.equal((await issue(e.id, 5.555)).status, 400);
  assert.equal((await A("POST", "/employee-advances/issue", { employeeId: e.id, amount: 5 })).status, 400, "المفتاح إلزامي");
});

suite("advance default period skips a paid/closed current period; explicit period can be chosen", async () => {
  const e = await mkEmp({ salary: 100 });
  await salaryExp(e.id, 100); // الشهر الحالي مدفوع بالكامل
  assert.equal((await summary(e.id)).defaultAdvancePeriodKey, NEXT, "المدفوعة لا تقبل سلفاً");
  const r = await issue(e.id, 30);
  assert.equal(r.status, 201);
  assert.equal(r.json.advance.deductionPeriodKey, NEXT);
  // إغلاق الشهر الحالي ثم سلفة بفترة صريحة قديمة مغلقة → مرفوضة
  assert.equal((await A("POST", `/employees/${e.id}/close-period`, { periodKey: CUR })).status, 200);
  assert.equal((await issue(e.id, 5, { deductionPeriodKey: CUR })).status, 409);
  const far = addMonths(CUR, 3);
  const chosen = await issue(e.id, 5, { deductionPeriodKey: far });
  assert.equal(chosen.status, 201);
  assert.equal(chosen.json.advance.deductionPeriodKey, far);
  // الموظف الآخر لا يتأثر بفترة موظف
  const other = await mkEmp({ salary: 100 });
  assert.equal((await summary(other.id)).defaultAdvancePeriodKey, CUR);
});

suite("auto settlement at salary payment, partial settlement and carry-forward, no second advance or cash", async () => {
  const e = await mkEmp({ salary: 1000 });
  const a = (await issue(e.id, 300)).json.advance;
  const bal0 = await balance("USD");
  const before = await summary(e.id);
  assert.equal(before.scheduledSettlement, 300);
  assert.equal(before.remainingPayable, 700);
  const r = await salaryExp(e.id, 400);
  assert.equal(r.status, 201);
  const s = r.json.summary;
  assert.equal(s.settlementsApplied, 300);
  assert.equal(s.paid, 400);
  assert.equal(s.remainingPayable, 300);
  assert.equal(s.scheduledSettlement, 0);
  assert.equal(s.advances.outstanding, 0);
  assert.equal(await balance("USD"), bal0 - 400, "التسوية لا تُخرج نقداً");
  const types = (await ledgerOf(e.id)).map((l) => l.type);
  assert.ok(types.includes("advance_settlement") && types.includes("salary_payment") && types.includes("advance_disbursement"));
  assert.equal(types.filter((t) => t === "advance_disbursement").length, 1);
  // سلفة أكبر من الراتب: تُسوّى جزئياً ويُرحَّل الباقي
  const e2 = await mkEmp({ salary: 100 });
  const big = (await issue(e2.id, 150)).json.advance;
  const bal1 = await balance("USD");
  const s2 = await summary(e2.id);
  assert.equal(s2.scheduledSettlement, 100);
  assert.equal(s2.carryForward, 50);
  assert.equal(s2.remainingPayable, 0);
  assert.equal(s2.canPay, false);
  assert.equal(s2.reason, "NO_SALARY_DUE");
  const applied = await A("POST", `/employees/${e2.id}/settle-advances`, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(applied.json.summary.settlementsApplied, 100);
  assert.equal(applied.json.summary.status, "paid");
  assert.equal(applied.json.summary.advances.outstanding, 50);
  const adv = (await A("GET", `/employee-advances/${big.id}`)).json.advance;
  assert.equal(adv.status, "partially_settled");
  assert.equal(adv.settled, 100);
  assert.equal(adv.outstanding, 50);
  assert.equal(adv.deductionPeriodKey, NEXT, "رُحِّل الباقي إلى الشهر التالي");
  assert.equal(await balance("USD"), bal1, "لا صرف جديد");
  assert.equal((await A("GET", `/employee-advances?employeeId=${e2.id}`)).json.total, 1, "لا سلفة ثانية");
  const led = await ledgerOf(e2.id);
  assert.ok(led.some((l) => l.type === "adjustment" && l.advanceId === big.id && l.amount === 50), "قيد الترحيل");
  assert.equal(led.filter((l) => l.type === "advance_settlement").length, 1);
  // التطبيق المتكرر لا يُسوّي مرتين
  const twice = await A("POST", `/employees/${e2.id}/settle-advances`, {});
  assert.equal(twice.status, 200);
  assert.equal(twice.json.settledMinor, 0);
  assert.equal((await A("GET", `/employee-advances/${big.id}`)).json.advance.settled, 100);
  // الشهر التالي: يُخصم الباقي من راتبه
  const nxt = await summary(e2.id, NEXT);
  assert.equal(nxt.scheduledSettlement, 50);
  assert.equal(nxt.entitlement, 100);
  assert.equal(nxt.remainingPayable, 50);
  // إغلاق الشهر الحالي (مدفوع بالتسوية) ثم عدم إمكان تعديله
  assert.equal((await A("POST", `/employees/${e2.id}/close-period`, { periodKey: CUR })).status, 200);
  assert.equal((await salaryExp(e2.id, 1, { periodKey: CUR })).json.code, "PERIOD_CLOSED");
});

suite("reversals: salary expense reversal restores remaining and cash; settlement reversal restores the advance", async () => {
  const e = await mkEmp({ salary: 1000 });
  await issue(e.id, 200);
  const bal0 = await balance("USD");
  const exp0 = await dashExpenses("USD");
  const r = await salaryExp(e.id, 500);
  assert.equal(r.json.summary.remainingPayable, 300);
  assert.equal(await balance("USD"), bal0 - 500);
  const rev = await A("POST", `/finance/expenses/${r.json.expense.id}/reverse`, { reason: "خطأ إدخال" });
  assert.equal(rev.status, 201, JSON.stringify(rev.json));
  assert.equal(rev.json.expense.status, "reversed");
  assert.equal(await balance("USD"), bal0, "عاد المبلغ إلى الصندوق");
  assert.equal(await dashExpenses("USD"), exp0, "المصروف المعكوس لا يُحتسب");
  const s = await summary(e.id);
  assert.equal(s.paid, 0);
  assert.equal(s.settlementsApplied, 200, "التسوية تبقى (قيد مستقل)");
  assert.equal(s.remainingPayable, 800);
  assert.equal((await A("POST", `/finance/expenses/${r.json.expense.id}/reverse`, { reason: "ثانية" })).status, 409);
  // عكس التسوية
  const st = (await ledgerOf(e.id, "&type=advance_settlement&state=posted"))[0];
  const adv = (await ledgerOf(e.id, "&type=advance_disbursement"))[0];
  const undo = await A("POST", `/employee-advances/${adv.advanceId}/settlements/${st.id}/reverse`, { reason: "تصحيح" });
  assert.equal(undo.status, 201);
  const s2 = await summary(e.id);
  assert.equal(s2.settlementsApplied, 0);
  assert.equal(s2.advances.outstanding, 200);
  assert.equal(s2.remainingPayable, 800, "المتبقي بعد المجدول");
  // السجل يحفظ الأصل والعكس
  const led = await ledgerOf(e.id);
  assert.ok(led.some((l) => l.type === "salary_payment" && l.state === "reversed"));
  assert.ok(led.some((l) => l.type === "reversal"));
});

suite("atomicity: failed cash posting leaves no expense, ledger entry or counter change", async () => {
  const e = await mkEmp({ salary: 400 });
  const cashRepo = require("../../src/repositories/cash.repository");
  const original = cashRepo.create;
  cashRepo.create = async () => { throw new Error("boom"); };
  let res;
  try { res = await salaryExp(e.id, 100); } finally { cashRepo.create = original; }
  assert.equal(res.status, 500);
  const s = await summary(e.id);
  assert.equal(s.paid, 0);
  assert.equal(s.remainingPayable, 400);
  assert.ok(!(await ledgerOf(e.id)).some((l) => l.type === "salary_payment"));
  assert.equal((await A("GET", "/finance/expenses?limit=100")).json.items.filter((x) => x.employeeId === e.id).length, 0);
  assert.equal((await salaryExp(e.id, 100)).status, 201, "المفتاح لم يُستهلك: العملية تنجح بعد زوال العطل");
});

suite("SYP employee: whole pounds in the SYP register only", async () => {
  const e = await mkEmp({ salary: 3000000, currency: "SYP" });
  const usd0 = await balance("USD");
  const syp0 = await balance("SYP");
  const r = await A("POST", "/finance/expenses", { currency: "SYP", amount: 1000000, category: "رواتب", employeeId: e.id, idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.summary.remainingPayable, 2000000);
  assert.equal(await balance("SYP"), syp0 - 1000000);
  assert.equal(await balance("USD"), usd0);
  assert.equal((await A("POST", "/finance/expenses", { currency: "SYP", amount: 100.5, category: "رواتب", employeeId: e.id, idempotencyKey: key() })).status, 400);
  assert.equal((await A("POST", "/finance/expenses", { currency: "USD", amount: 100, category: "رواتب", employeeId: e.id, idempotencyKey: key() })).json.code, "CURRENCY_MISMATCH");
});

suite("RBAC: employees and anonymous callers cannot read summaries, pay salary, issue advances or settle", async () => {
  const e = await mkEmp({ salary: 500 });
  const id = e.id;
  const calls = [
    ["GET", `/employees/${id}/payroll-summary`], ["POST", `/employees/${id}/adjustments`, { kind: "bonus", amount: 1, note: "x", idempotencyKey: key() }],
    ["POST", `/employees/${id}/settle-advances`, {}], ["POST", `/employees/${id}/close-period`, { periodKey: CUR }],
    ["POST", "/employee-advances/issue", { employeeId: id, amount: 5, idempotencyKey: key() }],
    ["POST", "/finance/expenses", { currency: "USD", amount: 5, category: "رواتب", employeeId: id, idempotencyKey: key() }],
  ];
  for (const [m, u, b] of calls) {
    assert.equal((await call(emp, m, u, b)).status, 403, `employee ${m} ${u}`);
    assert.equal((await call(null, m, u, b)).status, 401, `anonymous ${m} ${u}`);
  }
  const s = await summary(id);
  assert.equal(s.paid, 0);
  assert.equal(s.advances.outstanding, 0);
});

suite("adjustments: before the first payment only; period resolved automatically", async () => {
  const e = await mkEmp({ salary: 1000 });
  const adj = (kind, amount) => A("POST", `/employees/${e.id}/adjustments`, { kind, amount, note: "اختبار", idempotencyKey: key() });
  assert.equal((await adj("allowance", 100)).status, 201);
  assert.equal((await adj("deduction", 30)).status, 201);
  const s = await summary(e.id);
  assert.equal(s.entitlement, 1070);
  assert.equal(s.allowances, 100);
  assert.equal(s.deductions, 30);
  await salaryExp(e.id, 100);
  assert.equal((await adj("bonus", 10)).status, 409, "بعد أول دفعة تُقفل المكوّنات");
  assert.equal((await summary(e.id)).entitlement, 1070);
});

suite("integrity: independent check reconciles cash, expenses, advances, payroll counters", async () => {
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const check = await verifyIntegrity(mongoose.connection.db);
  assert.deepEqual(check.problems, []);
  assert.equal(check.ok, true);
});
