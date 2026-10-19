/*
 * تصحيحات التدقيق (F1–F10): بصمة المفتاح، مسار دفع واحد، إغلاق ذرّي، اتساق القائمة والحساب، الأشهر، أهلية الفترة،
 * الموظف غير الفعّال، فئة الراتب، صلاحية العكس، وحقن الأعطال. تُشغَّل بـ:
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_efix" بالكامل (اسمها يجب أن يحوي test). تعمل على standalone وعلى Replica Set.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_efix$2") : RAW;
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

const mkEmp = async (o = {}) => (await A("POST", "/employees", { name: `موظف تصحيح ${++n}`, salary: 1000, currency: "USD", ...o })).json;
const summary = async (id, period) => (await A("GET", `/employees/${id}/payroll-summary${period ? `?period=${period}` : ""}`)).json;
const salaryExp = (employeeId, amount, extra = {}) => A("POST", "/finance/expenses", { currency: "USD", amount, category: "رواتب", employeeId, idempotencyKey: key(), ...extra });
const issue = (employeeId, amount, extra = {}) => A("POST", "/employee-advances/issue", { employeeId, amount, idempotencyKey: key(), ...extra });
const cashRows = async () => (await A("GET", "/finance/cash?limit=100")).json.items;
const expenseRows = async () => (await A("GET", "/finance/expenses?limit=100")).json.items;
const range = () => `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5 * 40).toISOString())}`;
const balance = async (cur) => (await A("GET", `/finance/dashboard?${range()}`)).json[cur].balance;
const ledgerOf = async (id, q = "") => (await A("GET", `/employees/${id}/ledger?limit=100${q}`)).json.items;
const listRow = async (e) => (await A("GET", `/employees?q=${encodeURIComponent(e.name)}&limit=50`)).json.items.find((x) => x.id === e.id);
// لقطة حالة للمقارنة قبل/بعد فشل مُحقَن: لا بقايا في أي سجل
const snap = async (e) => ({
  summary: await summary(e.id), ledger: (await ledgerOf(e.id)).length, expenses: (await expenseRows()).filter((x) => x.employeeId === e.id).length,
  cash: (await cashRows()).length, balance: await balance("USD"),
});

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
  await require("../../src/models/user.model").create({ name: "المالك", username: "fx-owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  admin = await login("fx-owner", "Owner-Test-Pass1");
  assert.equal((await A("POST", "/users", { name: "كاشير", username: "fx-clerk", password: "Clerk-Test-Pass1" })).status, 201);
  emp = await login("fx-clerk", "Clerk-Test-Pass1");
  await A("POST", "/finance/cash", { currency: "USD", direction: "in", amount: 100000, note: "افتتاحي", idempotencyKey: key() });
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

// ═════════ F2: بصمة الطلب مرتبطة بالمفتاح ═════════
suite("F2 salary: same key + same request = original; different employee/amount/method/period = 409 and no effect", async () => {
  const e1 = await mkEmp({ salary: 1000 });
  const e2 = await mkEmp({ salary: 500 });
  const k = key();
  const first = await salaryExp(e1.id, 100, { idempotencyKey: k });
  assert.equal(first.status, 201);
  const again = await salaryExp(e1.id, 100, { idempotencyKey: k });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.expense.id, first.json.expense.id);
  for (const [label, r] of [
    ["employee", await salaryExp(e2.id, 100, { idempotencyKey: k })],
    ["amount", await salaryExp(e1.id, 101, { idempotencyKey: k })],
    ["method", await salaryExp(e1.id, 100, { idempotencyKey: k, method: "other" })],
    ["period", await salaryExp(e1.id, 100, { idempotencyKey: k, periodKey: CUR })],
  ]) {
    assert.equal(r.status, 409, label);
    assert.equal(r.json.code, "IDEMPOTENCY_KEY_REUSED", label);
  }
  assert.equal((await summary(e2.id)).paid, 0, "الموظف الآخر لم يُدفع له شيء");
  assert.equal((await summary(e1.id)).paid, 100, "أثر واحد فقط");
  // الوصف والتاريخ ليسا من البصمة (إعادة إرسال بنفس المعطيات الجوهرية آمنة)
  assert.equal((await salaryExp(e1.id, 100, { idempotencyKey: k, description: "نص مختلف" })).status, 200);
});

suite("F2 advance: same key reuse with different amount/period/method = 409; identical retry = original", async () => {
  const e = await mkEmp({ salary: 1000 });
  const k = key();
  const first = await issue(e.id, 50, { idempotencyKey: k });
  assert.equal(first.status, 201);
  const same = await issue(e.id, 50, { idempotencyKey: k });
  assert.equal(same.status, 200);
  assert.equal(same.json.advance.id, first.json.advance.id);
  for (const extra of [{ amount: 999 }, { method: "other" }, { deductionPeriodKey: addMonths(CUR, 2) }]) {
    const r = await issue(e.id, extra.amount || 50, { idempotencyKey: k, ...extra });
    assert.equal(r.status, 409, JSON.stringify(extra));
    assert.equal(r.json.code, "IDEMPOTENCY_KEY_REUSED");
  }
  assert.equal((await A("GET", `/employee-advances?employeeId=${e.id}`)).json.total, 1);
  assert.equal((await summary(e.id)).advances.outstanding, 50);
});

suite("F2 low-level ledger operations (adjustment / settlement / reassign) also bind the key to the request", async () => {
  const e = await mkEmp({ salary: 1000 });
  const p = (await A("POST", "/payroll-periods", { employeeId: e.id, periodKey: CUR })).json.period;
  const k = key();
  const adj = (amount) => A("POST", `/payroll-periods/${p.id}/adjustments`, { kind: "bonus", amount, note: "x", idempotencyKey: k });
  assert.equal((await adj(10)).status, 201);
  assert.equal((await adj(10)).status, 200);
  assert.equal((await adj(11)).json.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await summary(e.id)).allowances + (await summary(e.id)).bonuses, 10);
  await A("POST", `/payroll-periods/${p.id}/approve`, {});
  const a = (await A("POST", "/employee-advances", { employeeId: e.id, deductionPeriodId: p.id, amount: 100, idempotencyKey: key() })).json.advance;
  await A("POST", `/employee-advances/${a.id}/disburse`, {});
  const ks = key();
  const settle = (amount) => A("POST", `/employee-advances/${a.id}/settlements`, { amount, idempotencyKey: ks });
  assert.equal((await settle(40)).status, 201);
  assert.equal((await settle(40)).status, 200);
  assert.equal((await settle(41)).json.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await A("GET", `/employee-advances/${a.id}`)).json.advance.settled, 40);
});

suite("F2 concurrency: identical requests → one effect; conflicting requests with one key → exactly one winner", async () => {
  const e = await mkEmp({ salary: 1000 });
  const bal0 = await balance("USD");
  const k = key();
  const same = await Promise.all(Array.from({ length: 8 }, () => salaryExp(e.id, 100, { idempotencyKey: k })));
  assert.equal(same.filter((r) => r.status === 201).length, 1);
  assert.ok(same.every((r) => [200, 201, 409].includes(r.status)));
  assert.equal(await balance("USD"), bal0 - 100);
  const k2 = key();
  const mixed = await Promise.all(Array.from({ length: 8 }, (_, i) => salaryExp(e.id, i % 2 ? 100 : 200, { idempotencyKey: k2 })));
  assert.equal(mixed.filter((r) => r.status === 201).length, 1, JSON.stringify(mixed.map((r) => r.status)));
  const winner = mixed.find((r) => r.status === 201).json.expense.amount;
  assert.ok(mixed.filter((r) => r.status !== 201).every((r) => r.status === 409 || (r.status === 200 && r.json.duplicate === true && r.json.expense?.amount === winner)), "المخالفون يُرفضون: " + JSON.stringify(mixed.map((r) => [r.status, r.json.code || r.json.expense?.amount])));
  assert.equal(await balance("USD"), bal0 - 100 - winner);
  assert.equal((await expenseRows()).filter((x) => x.employeeId === e.id).length, 2, "مصروفان فقط (واحد لكل مفتاح)");
  // سلف
  const k3 = key();
  const adv = await Promise.all(Array.from({ length: 6 }, (_, i) => issue(e.id, i % 2 ? 20 : 30, { idempotencyKey: k3 })));
  assert.equal(adv.filter((r) => r.status === 201).length, 1, JSON.stringify(adv.map((r) => r.status)));
  assert.equal((await A("GET", `/employee-advances?employeeId=${e.id}`)).json.total, 1);
});

// ═════════ F5: مسار دفع وحيد ═════════
suite("F5 legacy POST /payroll-periods/:id/payments goes through the single service (expense + cash + auto settlement)", async () => {
  const e = await mkEmp({ salary: 1000 });
  await issue(e.id, 300);
  const p = (await A("GET", `/employees/${e.id}/payroll-periods`)).json.items[0];
  const draft = await A("POST", `/payroll-periods/${p.id}/payments`, { amount: 10, idempotencyKey: key() });
  assert.equal(draft.status, 409, "العقد القديم: لا دفع قبل الاعتماد");
  assert.equal((await A("POST", `/payroll-periods/${p.id}/approve`, {})).status, 200);
  const bal0 = await balance("USD");
  const tooMuch = await A("POST", `/payroll-periods/${p.id}/payments`, { amount: 900, idempotencyKey: key() });
  assert.equal(tooMuch.status, 409, "المتاح 700 بعد خصم السلفة المجدولة (كان 900 يمرّ سابقاً)");
  assert.equal(tooMuch.json.code, "EXCEEDS_REMAINING");
  const k = key();
  const ok = await A("POST", `/payroll-periods/${p.id}/payments`, { amount: 400, idempotencyKey: k, note: "دفعة" });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.ok(ok.json.entry.id && ok.json.period.paid === 400 && ok.json.period.advanceSettlements === 300 && ok.json.expense.category === "رواتب");
  assert.equal(await balance("USD"), bal0 - 400);
  const exp = (await expenseRows()).filter((x) => x.employeeId === e.id);
  assert.equal(exp.length, 1, "تظهر في مصروفات المالية");
  assert.equal((await A("POST", `/payroll-periods/${p.id}/payments`, { amount: 400, idempotencyKey: k })).status, 200);
  assert.equal((await A("POST", `/payroll-periods/${p.id}/payments`, { amount: 401, idempotencyKey: k })).json.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await cashRows()).filter((m) => m.source.ref === exp[0].ref).length, 1);
  assert.equal((await A("POST", `/payroll-periods/${p.id}/payments`, { amount: 10, currency: "SYP", idempotencyKey: key() })).json.code, "CURRENCY_MISMATCH");
  // العكس عبر المسار القديم يعكس المصروف وحركته
  const rv = await A("POST", `/payroll-periods/${p.id}/payments/${ok.json.entry.id}/reverse`, { reason: "اختبار" });
  assert.equal(rv.status, 201);
  assert.equal(await balance("USD"), bal0);
  assert.equal((await expenseRows()).find((x) => x.id === exp[0].id).status, "reversed");
  // لا يبقى أي مسار يُنشئ دفعة بلا مصروف
  const s = await summary(e.id);
  assert.equal(s.paid, 0);
});

// ═════════ F8: إغلاق ذرّي ═════════
suite("F8 close-period is one atomic unit: success path, rejected unpaid close leaves no side effects", async () => {
  const e = await mkEmp({ salary: 100 });
  await issue(e.id, 100); // الخصم المجدول يستغرق الراتب كله
  const before = await snap(e);
  assert.equal(before.summary.status, "draft");
  const ok = await A("POST", `/employees/${e.id}/close-period`, { periodKey: CUR });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.period.status, "closed");
  const s = await summary(e.id);
  assert.equal(s.settlementsApplied, 100);
  assert.equal(s.advances.outstanding, 0);
  // إغلاق غير مدفوعة: يُرفض بلا أي أثر (كان يعتمد الفترة ويُسوّي السلفة قبل الرفض)
  const e2 = await mkEmp({ salary: 100 });
  await A("POST", `/employees/${e2.id}/adjustments`, { kind: "bonus", amount: 10, note: "x", idempotencyKey: key() });
  await issue(e2.id, 40);
  const b2 = await snap(e2);
  const rej = await A("POST", `/employees/${e2.id}/close-period`, { periodKey: CUR });
  assert.equal(rej.status, 409);
  const a2 = await snap(e2);
  assert.equal(a2.summary.status, "draft", "لم تُعتمد");
  assert.equal(a2.summary.settlementsApplied, 0, "لم تُسوَّ السلفة");
  assert.equal(a2.summary.advances.outstanding, 40);
  assert.equal(a2.ledger, b2.ledger, "لا قيود جديدة");
  assert.equal((await A("POST", `/payroll-periods/${(await A("GET", `/employees/${e2.id}/payroll-periods`)).json.items[0].id}/close`, {})).status, 409, "المسار القديم لإغلاق الفترة يمرّ بالخدمة نفسها");
});

suite("F8 failure injection: a failure at any stage of close leaves nothing partially applied", async () => {
  const payrollRepo = require("../../src/repositories/payroll.repository");
  const advanceRepo = require("../../src/repositories/employeeAdvance.repository");
  const ledgerRepo = require("../../src/repositories/employeeLedger.repository");
  for (const [label, target, name] of [["status update (last stage)", payrollRepo, "close"], ["advance settlement (middle)", advanceRepo, "settle"], ["approval (first stage)", payrollRepo, "approve"]]) {
    const e = await mkEmp({ salary: 100 });
    await issue(e.id, 100);
    const before = await snap(e);
    const original = target[name];
    target[name] = async () => { throw new Error("boom " + label); };
    let res;
    try { res = await A("POST", `/employees/${e.id}/close-period`, { periodKey: CUR }); } finally { target[name] = original; }
    assert.equal(res.status, 500, label);
    const after = await snap(e);
    assert.equal(after.summary.status, before.summary.status, `${label}: الحالة`);
    assert.equal(after.summary.settlementsApplied, 0, `${label}: لا تسوية جزئية`);
    assert.equal(after.summary.advances.outstanding, 100, `${label}: السلفة كما هي`);
    assert.equal(after.ledger, before.ledger, `${label}: لا قيود متبقية`);
    assert.equal(after.cash, before.cash);
    // وبعد زوال العطل تنجح العملية نفسها
    assert.equal((await A("POST", `/employees/${e.id}/close-period`, { periodKey: CUR })).status, 200, label);
  }
  assert.ok(ledgerRepo);
});

// ═════════ F4: القائمة = الحساب ═════════
suite("F4 list and account share one authoritative summary in every scenario", async () => {
  const scenarios = [];
  const plain = await mkEmp({ salary: 1000 });
  scenarios.push(["no advances", plain]);
  const sched = await mkEmp({ salary: 1000 });
  await issue(sched.id, 300);
  scenarios.push(["scheduled advance", sched]);
  const part = await mkEmp({ salary: 1000 });
  await issue(part.id, 300);
  await salaryExp(part.id, 400);
  scenarios.push(["partial payment + settled advance", part]);
  const carry = await mkEmp({ salary: 100 });
  await issue(carry.id, 150);
  await A("POST", `/employees/${carry.id}/settle-advances`, {});
  scenarios.push(["carried-forward advance", carry]);
  const full = await mkEmp({ salary: 200 });
  await salaryExp(full.id, 200);
  scenarios.push(["fully paid", full]);
  const partial2 = await mkEmp({ salary: 1000 });
  await issue(partial2.id, 500);
  await salaryExp(partial2.id, 100);
  scenarios.push(["partially settled big advance", partial2]);
  for (const [label, e] of scenarios) {
    const row = await listRow(e);
    const s = await summary(e.id);
    assert.equal(row.periodKey, s.periodKey, `${label}: الشهر`);
    assert.equal(row.due.remaining, s.remainingPayable, `${label}: المتبقي للدفع`);
    assert.equal(row.due.net, s.entitlement, `${label}: الصافي`);
    assert.equal(row.due.paid, s.paid, `${label}: المدفوع`);
    assert.equal(row.due.scheduledSettlement, s.scheduledSettlement, `${label}: التسوية المجدولة`);
    assert.equal(row.advancesOutstanding, s.advances.outstanding, `${label}: السلف القائمة`);
    assert.equal(row.indicator, s.indicator, `${label}: المؤشر`);
    assert.equal(row.canPay, s.canPay, `${label}: إمكانية الدفع`);
  }
  assert.equal((await listRow(sched)).due.remaining, 700, "سلفة مجدولة: المتبقي بعد الخصم لا الراتب كاملاً");
  assert.equal((await listRow(full)).due.remaining, 0);
  assert.equal((await listRow(carry)).advancesOutstanding, 50, "رصيد السلفة منفصل عن الراتب");
  const explicit = (await A("GET", `/employees?q=${encodeURIComponent(sched.name)}&periodKey=${CUR}`)).json;
  assert.equal(explicit.currentKey, CUR, "الخادم هو مصدر الشهر الحالي");
  assert.equal(explicit.items[0].due.remaining, 700);
});

// ═════════ F6: الشهر من الخادم ═════════
suite("F6 server is the single source of the current month (list, summary, advance default)", async () => {
  const e = await mkEmp({ salary: 100 });
  const s = await summary(e.id);
  const l = (await A("GET", "/employees?limit=1")).json;
  assert.equal(s.currentKey, CUR);
  assert.equal(l.currentKey, CUR);
  assert.equal(s.defaultAdvancePeriodKey, CUR);
  assert.equal((await salaryExp(e.id, 10, { periodKey: NEXT })).json.code, "FUTURE_PERIOD");
  assert.equal((await summary(e.id, NEXT)).reason, "FUTURE_PERIOD");
});

// ═════════ F3: أهلية الفترة ═════════
suite("F3 no period before the hire month; no invented historical salary; salary change takes effect from the current month", async () => {
  const hiredLater = await mkEmp({ salary: 500, hireDate: new Date(`${NEXT}-05T00:00:00Z`).toISOString() });
  const s = await summary(hiredLater.id);
  assert.equal(s.canPay, false);
  assert.equal(s.reason, "BEFORE_HIRE", "الشهر الحالي قبل شهر التعيين");
  const createBefore = await A("POST", "/payroll-periods", { employeeId: hiredLater.id, periodKey: CUR });
  assert.equal(createBefore.status, 409);
  assert.equal(createBefore.json.code, "BEFORE_HIRE");
  assert.equal((await salaryExp(hiredLater.id, 10)).json.code, "BEFORE_HIRE");
  // شهر ماضٍ بعد التعيين لكن قبل أي تاريخ معروف لسريان الراتب: مرفوض (لا لقطة مخترعة)
  const old = await mkEmp({ salary: 1000, hireDate: new Date(`${addMonths(CUR, -3)}-01T00:00:00Z`).toISOString() });
  const unknown = await salaryExp(old.id, 100, { periodKey: PREV });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.json.code, "HISTORICAL_SALARY_UNKNOWN");
  assert.equal((await summary(old.id, PREV)).reason, "HISTORICAL_SALARY_UNKNOWN");
  assert.equal((await A("GET", `/employees/${old.id}/payroll-periods`)).json.total, 0, "لم تُنشأ فترة");
  // تصريح صريح من المالك بشهر سريان الراتب: لقطة معروفة وصالحة
  const known = await mkEmp({ salary: 1000, hireDate: new Date(`${addMonths(CUR, -3)}-01T00:00:00Z`).toISOString(), salaryEffectiveFrom: addMonths(CUR, -2) });
  const okPast = await salaryExp(known.id, 100, { periodKey: PREV });
  assert.equal(okPast.status, 201, JSON.stringify(okPast.json));
  assert.equal(okPast.json.summary.baseSalary, 1000);
  assert.equal((await salaryExp(known.id, 100, { periodKey: addMonths(CUR, -3) })).json.code, "HISTORICAL_SALARY_UNKNOWN");
  assert.equal((await A("PATCH", `/employees/${known.id}`, { salaryEffectiveFrom: NEXT })).status, 400, "لا سريان في المستقبل");
  // تغيير الراتب: الفترة القائمة تحتفظ بلقطتها، والسريان الجديد من الشهر الحالي
  const raised = await A("PATCH", `/employees/${known.id}`, { salary: 2000 });
  assert.equal(raised.json.salaryEffectiveFrom, CUR);
  assert.equal((await summary(known.id, PREV)).baseSalary, 1000, "لقطة الشهر الماضي لا تتغير");
  assert.equal((await summary(known.id, CUR)).baseSalary, 2000, "الشهر الحالي بالراتب الجديد");
  assert.equal((await salaryExp(known.id, 50, { periodKey: addMonths(CUR, -2) })).json.code, "HISTORICAL_SALARY_UNKNOWN", "شهر أقدم من السريان الجديد لا يُنشأ بالراتب الحالي");
});

// ═════════ F7: موظف غير فعّال ═════════
suite("F7 inactive employee: an advance that cannot be carried is never written off, never half-processed", async () => {
  const e = await mkEmp({ salary: 100 });
  await issue(e.id, 150);
  await A("PATCH", `/employees/${e.id}`, { status: "terminated" });
  const before = await snap(e);
  const s = before.summary;
  assert.equal(s.canPay, false);
  assert.equal(s.reason, "INACTIVE_ADVANCE_CARRY");
  assert.equal(s.advances.outstanding, 150, "السلفة ظاهرة في الرصيد");
  const pay = await salaryExp(e.id, 1);
  assert.equal(pay.status, 409);
  assert.equal(pay.json.code, "INACTIVE_ADVANCE_CARRY");
  const apply = await A("POST", `/employees/${e.id}/settle-advances`, {});
  assert.equal(apply.json.code, "INACTIVE_ADVANCE_CARRY");
  const after = await snap(e);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.summary.advances.outstanding, 150);
  assert.equal(after.summary.settlementsApplied, 0);
  // بعد قرار إداري بإعادة التفعيل تعمل العملية نفسها
  await A("PATCH", `/employees/${e.id}`, { status: "active" });
  assert.equal((await A("POST", `/employees/${e.id}/settle-advances`, {})).status, 200);
  // موظف غير فعّال تتسع له السلفة بالكامل: تُسوّى دون ترحيل
  const f = await mkEmp({ salary: 200 });
  await issue(f.id, 80);
  await A("PATCH", `/employees/${f.id}`, { status: "inactive" });
  const sf = await summary(f.id);
  assert.equal(sf.canPay, true);
  assert.equal((await salaryExp(f.id, 120)).status, 201);
  assert.equal((await summary(f.id)).advances.outstanding, 0);
});

// ═════════ F10: فئة الراتب ═════════
suite("F10 salary category variants require an employee; canonical category stored; ordinary expenses unaffected", async () => {
  const e = await mkEmp({ salary: 1000 });
  for (const category of ["الرواتب", "راتب", "الراتب", "رواتب الموظفين", "Salary", "salaries", "رواتب ", " رواتب"]) {
    const r = await A("POST", "/finance/expenses", { currency: "USD", amount: 5, category, idempotencyKey: key() });
    assert.equal(r.status, 400, category);
    assert.equal(r.json.code, "EMPLOYEE_REQUIRED", category);
  }
  const ok = await A("POST", "/finance/expenses", { currency: "USD", amount: 5, category: "الرواتب", employeeId: e.id, idempotencyKey: key() });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.expense.category, "رواتب", "تُخزَّن الفئة المعيارية");
  for (const category of ["إيجار", "كهرباء وماء", "مواصلات", "أخرى"]) {
    const r = await A("POST", "/finance/expenses", { currency: "USD", amount: 5, category, idempotencyKey: key() });
    assert.equal(r.status, 201, category);
    assert.equal(r.json.expense.employeeId, null);
    assert.equal((await A("POST", "/finance/expenses", { currency: "USD", amount: 5, category, employeeId: e.id, idempotencyKey: key() })).json.code, "EMPLOYEE_ONLY_FOR_SALARY");
  }
  assert.equal((await call(emp, "POST", "/finance/expenses", { currency: "USD", amount: 5, category: "الراتب", employeeId: e.id, idempotencyKey: key() })).status, 403);
});

// ═════════ F9: صلاحية العكس ═════════
suite("F9 reversing a salary expense requires payroll.pay in addition to finance.manage; ordinary expenses do not", async () => {
  const e = await mkEmp({ salary: 500 });
  const sal = await salaryExp(e.id, 100);
  const ord = await A("POST", "/finance/expenses", { currency: "USD", amount: 7, category: "إيجار", idempotencyKey: key() });
  const controller = require("../../src/controllers/finance.controller");
  const mkRes = () => { const r = { status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; r.success = (b, c = 200) => { r.code = c; r.body = b; return r; }; return r; };
  const req = (perms, id) => ({ user: { id: "000000000000000000000001", name: "t", permissions: new Set(perms) }, valid: { params: { id }, body: { reason: "اختبار" } } });
  // finance.manage وحده (بلا payroll.pay): يُرفض لمصروف الراتب
  await assert.rejects(() => controller.expenseReverse(req(["finance.manage"], sal.json.expense.id), mkRes()), (err) => err.status === 403);
  assert.equal((await expenseRows()).find((x) => x.id === sal.json.expense.id).status, "posted", "لم يُعكس");
  assert.equal((await summary(e.id)).paid, 100);
  // المصروف العادي لا يتطلب payroll.pay
  const resOrd = mkRes();
  await controller.expenseReverse(req(["finance.manage"], ord.json.expense.id), resOrd);
  assert.equal(resOrd.code, 201);
  // مع الصلاحيتين يُعكس المصروف وأثره على الراتب
  const resSal = mkRes();
  await controller.expenseReverse(req(["finance.manage", "payroll.pay"], sal.json.expense.id), resSal);
  assert.equal(resSal.code, 201);
  assert.equal((await summary(e.id)).paid, 0);
  // عبر HTTP: الموظف (كاشير) ممنوع
  assert.equal((await call(emp, "POST", `/finance/expenses/${sal.json.expense.id}/reverse`, { reason: "x" })).status, 403);
});

// ═════════ F1: حقن أعطال في دفع الراتب ═════════
suite("F1 failure injection: salary payment leaves no residue when any stage fails (single failure at a time)", async () => {
  const cashRepo = require("../../src/repositories/cash.repository");
  const ledgerRepo = require("../../src/repositories/employeeLedger.repository");
  const payrollRepo = require("../../src/repositories/payroll.repository");
  const advanceRepo = require("../../src/repositories/employeeAdvance.repository");
  const stages = [
    ["cash row", cashRepo, "create"], ["expense row", cashRepo, "createExpense"], ["ledger link (last write)", ledgerRepo, "setLinks"],
    ["period counter update", payrollRepo, "adjust"], ["advance settlement", advanceRepo, "settle"], ["advance carry-forward", advanceRepo, "carryForward"],
  ];
  for (const [label, repo, name] of stages) {
    const e = await mkEmp({ salary: 100 });
    await issue(e.id, 150); // تسوية جزئية + ترحيل: تمرّ الدفعة بكل المراحل
    await A("POST", `/employees/${e.id}/adjustments`, { kind: "bonus", amount: 100, note: "x", idempotencyKey: key() }).catch(() => null);
    const before = await snap(e);
    const original = repo[name];
    repo[name] = async () => { throw new Error("boom " + label); };
    let res;
    try { res = await salaryExp(e.id, 10); } finally { repo[name] = original; }
    if (res.status === 201) { // المرحلة لم تُستدعَ في هذا السيناريو (مثلاً لا ترحيل)
      continue;
    }
    assert.equal(res.status, 500, label);
    const after = await snap(e);
    assert.equal(after.ledger, before.ledger, `${label}: القيود`);
    assert.equal(after.expenses, before.expenses, `${label}: المصروفات`);
    assert.equal(after.cash, before.cash, `${label}: حركات النقد`);
    assert.equal(after.balance, before.balance, `${label}: الرصيد`);
    assert.equal(after.summary.paid, before.summary.paid, `${label}: المدفوع`);
    assert.equal(after.summary.settlementsApplied, before.summary.settlementsApplied, `${label}: التسوية`);
    assert.equal(after.summary.advances.outstanding, before.summary.advances.outstanding, `${label}: السلفة`);
    assert.equal(after.summary.status, before.summary.status, `${label}: الحالة`);
  }
});

suite("F1 integrity check detects crash residue (orphan salary expense / unlinked payment) in an isolated database", async () => {
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const clean = await verifyIntegrity(mongoose.connection.db);
  assert.deepEqual(clean.problems, [], "قاعدة الاختبار سليمة قبل الإفساد المتعمد");
  // مصروف راتب بلا قيد دفعة (كما لو انقطعت العملية بعد المصروف قبل ربط الدفتر)
  const e = await mkEmp({ salary: 100 });
  const Expense = require("../../src/models/expense.model");
  const orphan = await Expense.create({ ref: "EXP-ORPHAN", currency: "USD", amountMinor: 500, category: "رواتب", date: new Date(), idempotencyKey: "orphan-test-key-1", employee: e.id, method: "other" });
  const broken = await verifyIntegrity(mongoose.connection.db);
  assert.ok(broken.problems.some((p) => p.includes("EXP-ORPHAN") && p.includes("بلا قيد دفعة")), JSON.stringify(broken.problems));
  await Expense.deleteOne({ _id: orphan._id }); // تنظيف قاعدة الاختبار فقط
  assert.deepEqual((await verifyIntegrity(mongoose.connection.db)).problems, []);
});

suite("final: independent integrity check is clean after all remediation scenarios", async () => {
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const c = await verifyIntegrity(mongoose.connection.db);
  assert.deepEqual(c.problems, []);
});
