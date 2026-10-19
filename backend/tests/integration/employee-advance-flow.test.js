/*
 * سلفة الموظف والتقارير: السلفة تُخرج نقداً حقيقياً ولا تُحتسب مصروفاً تشغيلياً ولا راتباً؛ التسوية من الراتب لا تُنشئ نقداً ولا مصروفاً.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_advflow" بالكامل (اسمها يجب أن يحوي test). تعمل على standalone وعلى Replica Set.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_advflow$2") : RAW;
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const suite = (name, fn) => test(name, { skip }, fn);

let mongoose, server, base, admin;
const call = async (s, method, p, body) => {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(s ? { Cookie: s.cookie, "x-csrf-token": s.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const A = (m, p, b) => call(admin, m, p, b);
const key = () => crypto.randomUUID();
const { currentKey, addMonths } = require("../../src/utils/payroll");
const CUR = currentKey();
const NEXT = addMonths(CUR, 1);
let n = 0;

const mkEmp = async (o = {}) => (await A("POST", "/employees", { name: `موظف سلف ${++n}`, salary: 1000, currency: "USD", ...o })).json;
const issue = (employeeId, amount, extra = {}) => A("POST", "/employee-advances/issue", { employeeId, amount, idempotencyKey: key(), ...extra });
const summary = async (id, period) => (await A("GET", `/employees/${id}/payroll-summary${period ? `?period=${period}` : ""}`)).json;
const advance = async (id) => (await A("GET", `/employee-advances/${id}`)).json;
const ledgerOf = async (id, q = "") => (await A("GET", `/employees/${id}/ledger?limit=100${q}`)).json.items;
const cashRows = async () => (await A("GET", "/finance/cash?limit=100")).json.items;
const expenseRows = async () => (await A("GET", "/finance/expenses?limit=100")).json.items;
const salaryExp = (employeeId, amount) => A("POST", "/finance/expenses", { currency: "USD", amount, category: "رواتب", employeeId, idempotencyKey: key() });
// لقطة التقارير الكاملة للدولار: الرصيد وحركة النقد والمصروفات (إجمالي/حسب الفئة) وصافي الربح وعدد صفوف المصروفات
async function report() {
  const range = `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5 * 40).toISOString())}`;
  const d = (await A("GET", `/finance/dashboard?${range}`)).json.USD;
  const rows = await expenseRows();
  const posted = rows.filter((x) => x.status === "posted" && x.currency === "USD");
  return {
    balance: d.balance, cashOut: d.cash.out, cashIn: d.cash.in, expenses: d.expenses, netProfit: d.netProfit, byCategory: JSON.stringify(d.expensesByCategory),
    expenseRows: rows.length, salaryExpenseRows: rows.filter((x) => x.category === "رواتب").length, expenseListSum: posted.reduce((s, x) => s + x.amount, 0),
    advanceCashRows: (await cashRows()).filter((m) => m.type === "employee_advance").length,
  };
}
const same = (a, b, fields, label) => { for (const f of fields) assert.equal(b[f], a[f], `${label}: ${f}`); };
const NO_EXPENSE_CHANGE = ["expenses", "netProfit", "byCategory", "expenseRows", "salaryExpenseRows", "expenseListSum"];

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
  await require("../../src/models/user.model").create({ name: "المالك", username: "af-owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  const res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: "af-owner", password: "Owner-Test-Pass1" }) });
  admin = { cookie: res.headers.getSetCookie().find((c) => c.startsWith("poplar_sid=")).split(";")[0], csrf: (await res.json()).csrfToken };
  await A("POST", "/finance/cash", { currency: "USD", direction: "in", amount: 100000, note: "افتتاحي", idempotencyKey: key() });
  // مصروف عادي سابق: يثبت أن الإجماليات الأخرى لا تتغير بسبب السلف
  assert.equal((await A("POST", "/finance/expenses", { currency: "USD", amount: 25, category: "إيجار", idempotencyKey: key() })).status, 201);
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

suite("1. cash advance of 100: register −100, one linked cash movement, employee outstanding +100, NO expense / salary / profit effect", async () => {
  const e = await mkEmp({ salary: 1000 });
  const before = await report();
  const r = await issue(e.id, 100);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const after = await report();
  assert.equal(after.balance, before.balance - 100, "الصندوق ينقص 100");
  assert.equal(after.cashOut, before.cashOut + 100, "تقرير النقد يُظهر الخارج الفعلي");
  assert.equal(after.cashIn, before.cashIn);
  same(before, after, NO_EXPENSE_CHANGE, "لا أثر على المصروفات/الراتب/الربح");
  assert.equal(after.advanceCashRows, before.advanceCashRows + 1);
  // الحركة النقدية مرتبطة بالسلفة والموظف: المصدر = السلفة، وقيد الدفتر يحمل معرّف الحركة
  const adv = r.json.advance;
  const mv = (await cashRows()).find((m) => m.source.ref === adv.ref);
  assert.equal(mv.type, "employee_advance");
  assert.equal(mv.direction, "out");
  assert.equal(mv.amount, 100);
  assert.equal(mv.currency, "USD");
  assert.equal(adv.disbursement.cashId, mv.id);
  const led = (await ledgerOf(e.id)).find((l) => l.type === "advance_disbursement");
  assert.equal(led.advanceId, adv.id);
  assert.equal(led.cashId, mv.id);
  assert.equal(led.expenseId, null, "لا مصروف مرتبطاً");
  // حساب الموظف: السلفة رصيد منفصل لا راتب مدفوع ولا استحقاق إضافي
  const s = await summary(e.id);
  assert.equal(s.advances.outstanding, 100);
  assert.equal(s.paid, 0);
  assert.equal(s.entitlement, 1000);
  assert.equal(s.settlementsApplied, 0);
  assert.equal(s.scheduledSettlement, 100, "مجدولة للخصم لا مخصومة بعد");
  assert.equal((await expenseRows()).filter((x) => x.employeeId === e.id).length, 0, "لا مصروف للموظف");
});

suite("2. non-cash advance: employee outstanding +100, no register movement, no expense", async () => {
  const e = await mkEmp({ salary: 1000 });
  const before = await report();
  const r = await issue(e.id, 100, { method: "other" });
  assert.equal(r.status, 201);
  const after = await report();
  same(before, after, ["balance", "cashOut", "cashIn", "advanceCashRows", ...NO_EXPENSE_CHANGE], "خارج الصندوق");
  assert.equal(r.json.advance.disbursement.method, "other");
  assert.equal(r.json.advance.disbursement.cashId, null);
  assert.ok(!(await cashRows()).some((m) => m.source.ref === r.json.advance.ref), "لا حركة نقد وهمية");
  assert.equal((await summary(e.id)).advances.outstanding, 100);
  assert.equal((await ledgerOf(e.id)).find((l) => l.type === "advance_disbursement").cashId, null);
});

suite("3. retries: same key sequential and concurrent create one advance and one cash movement", async () => {
  const e = await mkEmp({ salary: 1000 });
  const before = await report();
  const k = key();
  const a = await issue(e.id, 100, { idempotencyKey: k });
  const b = await issue(e.id, 100, { idempotencyKey: k });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.advance.id, a.json.advance.id);
  const k2 = key();
  const par = await Promise.all(Array.from({ length: 6 }, () => issue(e.id, 40, { idempotencyKey: k2 })));
  assert.equal(par.filter((r) => r.status === 201).length, 1, JSON.stringify(par.map((r) => r.status)));
  const after = await report();
  assert.equal(after.balance, before.balance - 140, "100 + 40 فقط");
  assert.equal(after.advanceCashRows, before.advanceCashRows + 2);
  assert.equal((await A("GET", `/employee-advances?employeeId=${e.id}`)).json.total, 2, "سلفتان فقط");
  same(before, after, NO_EXPENSE_CHANGE, "التكرار");
  assert.equal((await ledgerOf(e.id)).filter((l) => l.type === "advance_disbursement").length, 2);
});

suite("4. settling 40 of an advance through salary: outstanding −40, no cash outflow, no expense, salary figures not double counted", async () => {
  const e = await mkEmp({ salary: 1000 });
  const adv = (await issue(e.id, 100)).json.advance;
  const before = await report();
  const sBefore = await summary(e.id);
  const per = (await A("GET", `/employees/${e.id}/payroll-periods`)).json.items[0];
  await A("POST", `/payroll-periods/${per.id}/approve`, {});
  const st = await A("POST", `/employee-advances/${adv.id}/settlements`, { amount: 40, idempotencyKey: key() });
  assert.equal(st.status, 201, JSON.stringify(st.json));
  const after = await report();
  same(before, after, ["balance", "cashOut", "cashIn", "advanceCashRows", ...NO_EXPENSE_CHANGE], "التسوية");
  assert.equal((await cashRows()).filter((m) => m.source.ref === adv.ref).length, 1, "حركة النقد الوحيدة هي صرف السلفة");
  const s = await summary(e.id);
  assert.equal(s.advances.outstanding, 60);
  assert.equal(s.settlementsApplied, 40);
  assert.equal(s.paid, 0, "الخصم ليس راتباً مدفوعاً");
  assert.equal(s.entitlement, 1000);
  assert.equal(s.remainingBeforeSettlement, 960, "المتبقي = الصافي − التسوية − المدفوع");
  assert.equal(s.remainingPayable, 900, "بعد خصم الـ 60 المجدولة أيضاً (لا خصم مزدوج)");
  assert.equal(sBefore.remainingPayable, 900, "نفس المتبقي قبل وبعد: 40 المُسوّاة + 60 المجدولة = 100");
  assert.equal((await advance(adv.id)).advance.settled, 40);
  assert.equal((await expenseRows()).filter((x) => x.employeeId === e.id).length, 0);
});

suite("4b. salary payment with a scheduled advance: only the paid salary is an expense/cash-out; the deduction is neither", async () => {
  const e = await mkEmp({ salary: 1000 });
  await issue(e.id, 300);
  const before = await report();
  const r = await salaryExp(e.id, 400);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const after = await report();
  assert.equal(after.expenses, before.expenses + 400, "المصروف = الراتب المدفوع فقط (400) لا 700");
  assert.equal(after.balance, before.balance - 400, "النقد الخارج = 400 فقط");
  assert.equal(after.cashOut, before.cashOut + 400);
  assert.equal(after.advanceCashRows, before.advanceCashRows, "لا نقد جديد للسلفة");
  assert.equal(after.salaryExpenseRows, before.salaryExpenseRows + 1);
  const s = r.json.summary;
  assert.equal(s.paid, 400);
  assert.equal(s.settlementsApplied, 300);
  assert.equal(s.entitlement, 1000);
  assert.equal(s.remainingPayable, 300, "1000 − 400 مدفوع − 300 مُسوّى");
  assert.equal(s.advances.outstanding, 0);
});

suite("5. advance larger than the salary: partial settlement, remainder carried, no new advance, no new cash, no expense", async () => {
  const e = await mkEmp({ salary: 100 });
  const adv = (await issue(e.id, 150)).json.advance;
  const before = await report();
  const r = await A("POST", `/employees/${e.id}/settle-advances`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = await report();
  same(before, after, ["balance", "cashOut", "advanceCashRows", ...NO_EXPENSE_CHANGE], "الترحيل");
  const a = (await advance(adv.id)).advance;
  assert.equal(a.settled, 100);
  assert.equal(a.outstanding, 50);
  assert.equal(a.deductionPeriodKey, NEXT);
  assert.equal((await A("GET", `/employee-advances?employeeId=${e.id}`)).json.total, 1);
  const s = await summary(e.id);
  assert.equal(s.advances.outstanding, 50);
  assert.equal(s.status, "paid", "الراتب سُدِّد بالخصم");
  assert.equal(s.paid, 0, "لا دفع نقدي");
  // الشهر التالي يخصم الباقي من راتبه
  assert.equal((await summary(e.id, NEXT)).scheduledSettlement, 50);
});

suite("6. reversals: cash returns once, history kept, balances restored, no expense effect, no duplicates", async () => {
  const e = await mkEmp({ salary: 1000 });
  const before = await report();
  const adv = (await issue(e.id, 100)).json.advance;
  // عكس تسوية: يُعيد رصيد السلفة ولا يمسّ النقد ولا المصروفات
  const per = (await A("GET", `/employees/${e.id}/payroll-periods`)).json.items[0];
  await A("POST", `/payroll-periods/${per.id}/approve`, {});
  const st = (await A("POST", `/employee-advances/${adv.id}/settlements`, { amount: 40, idempotencyKey: key() })).json;
  const mid = await report();
  const undo = await A("POST", `/employee-advances/${adv.id}/settlements/${st.entry.id}/reverse`, { reason: "تصحيح" });
  assert.equal(undo.status, 201);
  same(mid, await report(), ["balance", "cashOut", "advanceCashRows", ...NO_EXPENSE_CHANGE], "عكس التسوية");
  assert.equal((await summary(e.id)).advances.outstanding, 100);
  assert.equal((await A("POST", `/employee-advances/${adv.id}/settlements/${st.entry.id}/reverse`, { reason: "ثانية" })).status, 409);
  // عكس السلفة نفسها: يعيد النقد مرة واحدة ويبقي الأصل والعكس
  const rev = await A("POST", `/employee-advances/${adv.id}/reversals`, { reason: "إلغاء" });
  assert.equal(rev.status, 201);
  const after = await report();
  assert.equal(after.balance, before.balance, "الصندوق كما كان");
  assert.equal(after.cashIn, before.cashIn + 100, "عكس النقد حركة وارد مستقلة");
  same(before, after, NO_EXPENSE_CHANGE, "عكس السلفة");
  const rows = (await cashRows()).filter((m) => m.source.ref === adv.ref);
  assert.equal(rows.length, 2, "الأصل + العكس (لا حذف ولا تكرار)");
  assert.ok(rows.some((m) => m.type === "employee_advance" && m.reversed === true));
  assert.ok(rows.some((m) => m.type === "payroll_reversal" && m.direction === "in" && m.amount === 100));
  assert.equal((await summary(e.id)).advances.outstanding, 0);
  assert.equal((await advance(adv.id)).advance.status, "reversed");
  const led = await ledgerOf(e.id);
  assert.ok(led.some((l) => l.type === "advance_disbursement" && l.state === "reversed"), "قيد الصرف الأصلي باقٍ");
  assert.ok(led.some((l) => l.type === "reversal" && l.reverseOf === "advance_disbursement"));
  assert.equal((await A("POST", `/employee-advances/${adv.id}/reversals`, { reason: "مرة ثانية" })).status, 409);
  assert.equal((await report()).balance, before.balance, "عكس مكرر لا يغيّر النقد");
});

suite("7. consistency: dashboard expenses = sum of posted expense rows; no advance category; integrity check clean", async () => {
  const r = await report();
  assert.equal(r.expenses, r.expenseListSum, "إجمالي المصروفات في اللوحة = مجموع صفوف المصروفات المسجَّلة");
  assert.ok(!r.byCategory.includes("سلف"), "لا فئة سلف ضمن المصروفات");
  assert.ok(!(await expenseRows()).some((x) => /سلف|advance/i.test(x.category)), "لا صف مصروف للسلف");
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const c = await verifyIntegrity(mongoose.connection.db);
  assert.deepEqual(c.problems, []);
});
