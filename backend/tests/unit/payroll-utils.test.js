const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../src/utils/payroll");
const { toMinorC, fromMinorC, validAmount } = require("../../src/utils/money");
const { presentPeriod, presentAdvance } = require("../../src/services/payroll.present");

const period = (o = {}) => ({ baseSalaryMinor: 100000, allowancesMinor: 0, bonusesMinor: 0, deductionsMinor: 0, settledMinor: 0, paidMinor: 0, status: "approved", currency: "USD", dueDate: new Date("2026-10-01"), ...o });

test("net = base + allowances + bonuses - deductions (integers, no float drift)", () => {
  assert.equal(P.netEntitlement(period({ allowancesMinor: 10000, bonusesMinor: 5000, deductionsMinor: 3000 })), 112000);
  // 0.1 + 0.2 كسنتات: يبقى الجمع صحيحاً بلا خطأ عائم
  assert.equal(P.netEntitlement(period({ baseSalaryMinor: 10, allowancesMinor: 20 })), 30);
});

test("remaining = net - advance settlements - payments; advances are not auto-deducted", () => {
  const p = period({ allowancesMinor: 10000, bonusesMinor: 5000, deductionsMinor: 3000, settledMinor: 20000, paidMinor: 50000 });
  assert.equal(P.remainingPayable(p), 42000);
  // سلفة مصروفة بلا تسوية لا تغيّر المتبقي
  assert.equal(P.remainingPayable(period()), 100000);
});

test("advance outstanding balance", () => {
  assert.equal(P.advanceOutstanding({ amountMinor: 50000, settledMinor: 0 }), 50000);
  assert.equal(P.advanceOutstanding({ amountMinor: 50000, settledMinor: 20000 }), 30000);
  assert.equal(P.advanceOutstanding({ amountMinor: 50000, settledMinor: 50000 }), 0);
});

test("derived status: partial and full payment", () => {
  assert.equal(P.derivedStatus(period()), "approved");
  assert.equal(P.derivedStatus(period({ paidMinor: 1 })), "partially_paid");
  assert.equal(P.derivedStatus(period({ settledMinor: 40000 })), "partially_paid");
  assert.equal(P.derivedStatus(period({ paidMinor: 60000, settledMinor: 40000 })), "paid");
  assert.equal(P.derivedStatus(period({ status: "draft", paidMinor: 5 })), "draft");
  assert.equal(P.derivedStatus(period({ status: "closed" })), "closed");
});

test("state transitions: only draft→approved and paid→closed are explicit", () => {
  assert.equal(P.canTransition("draft", "approve"), true);
  for (const s of ["approved", "partially_paid", "paid", "closed"]) assert.equal(P.canTransition(s, "approve"), false);
  assert.equal(P.canTransition("paid", "close"), true);
  for (const s of ["draft", "approved", "partially_paid", "closed"]) assert.equal(P.canTransition(s, "close"), false);
  assert.deepEqual(P.OPEN_FOR_PAYMENT, ["approved", "partially_paid"]);
  assert.ok(!P.OPEN_FOR_SETTLEMENT.includes("closed") && !P.OPEN_FOR_REVERSAL.includes("closed"));
});

test("period bounds and key validation", () => {
  const b = P.periodBounds("2026-02", 15);
  assert.equal(b.start.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(b.end.toISOString().slice(0, 10), "2026-02-28");
  assert.equal(b.dueDate.toISOString().slice(0, 10), "2026-02-15");
  assert.equal(P.periodBounds("2026-03", 99).dueDate.toISOString().slice(0, 10), "2026-03-28"); // يُقيَّد بـ 28
  for (const bad of ["2026-13", "2026-00", "26-10", "2026/10", ""]) assert.throws(() => P.periodBounds(bad));
});

test("indicator: pending / approved / partially_paid / paid / overdue / closed", () => {
  const now = new Date("2026-10-20");
  assert.equal(P.indicator(null, now), "none");
  assert.equal(P.indicator(period({ status: "draft" }), now), "pending");
  assert.equal(P.indicator(period({ status: "approved", dueDate: new Date("2026-10-25") }), now), "approved");
  assert.equal(P.indicator(period({ status: "approved" }), now), "overdue");
  assert.equal(P.indicator(period({ status: "partially_paid", paidMinor: 10 }), now), "overdue");
  assert.equal(P.indicator(period({ status: "paid", paidMinor: 100000 }), now), "paid");
  assert.equal(P.indicator(period({ status: "closed" }), now), "closed");
});

test("counters are rebuilt from the ledger; reversed entries and reversal rows cancel out", () => {
  const rows = [
    { type: "allowance", amountMinor: 100 }, { type: "bonus", amountMinor: 50 }, { type: "deduction", amountMinor: 30 },
    { type: "advance_settlement", amountMinor: 200 }, { type: "salary_payment", amountMinor: 500 },
    { type: "salary_payment", amountMinor: 300, reversedBy: "x" }, { type: "reversal", amountMinor: 300 },
    { type: "advance_disbursement", amountMinor: 999 }, { type: "salary_entitlement", amountMinor: 1000 },
  ];
  assert.deepEqual(P.countersFromLedger(rows), { allowancesMinor: 100, bonusesMinor: 50, deductionsMinor: 30, settledMinor: 200, paidMinor: 500 });
});

test("money: integer minor units per currency; precision rules", () => {
  assert.equal(toMinorC("USD", 1000.5), 100050);
  assert.equal(toMinorC("USD", 19.99), 1999);
  assert.equal(toMinorC("SYP", 1500000), 1500000);
  assert.equal(fromMinorC("USD", 100050), 1000.5);
  assert.equal(validAmount("USD", 10.005), false);
  assert.equal(validAmount("SYP", 10.5), false);
  assert.equal(validAmount("SYP", 10), true);
  // 0.1 + 0.2 بالسنت
  assert.equal(toMinorC("USD", 0.1) + toMinorC("USD", 0.2), toMinorC("USD", 0.3));
});

test("presenters derive net/remaining on the server in the record's own currency", () => {
  const p = presentPeriod(period({ _id: "a", employee: "e", ref: "PAY-1", periodKey: "2026-10", allowancesMinor: 10000, settledMinor: 20000, paidMinor: 50000 }), new Date("2026-09-01"));
  assert.equal(p.net, 1100);
  assert.equal(p.remaining, 400);
  assert.equal(p.advanceSettlements, 200);
  assert.equal(p.currency, "USD");
  const s = presentPeriod(period({ _id: "b", employee: "e", ref: "PAY-2", periodKey: "2026-10", currency: "SYP", baseSalaryMinor: 3000000, paidMinor: 1000000 }));
  assert.equal(s.net, 3000000);
  assert.equal(s.remaining, 2000000);
  const a = presentAdvance({ _id: "c", employee: "e", ref: "ADV-1", currency: "SYP", amountMinor: 500000, settledMinor: 200000, status: "partially_settled", deductionPeriod: "b" }, { b: "2026-10" });
  assert.equal(a.outstanding, 300000);
  assert.equal(a.deductionPeriodKey, "2026-10");
});

test("month keys: current key and month arithmetic across year boundaries", () => {
  assert.equal(P.currentKey(new Date("2026-10-19T10:00:00Z")), "2026-10");
  assert.equal(P.addMonths("2026-12", 1), "2027-01");
  assert.equal(P.addMonths("2026-01", -1), "2025-12");
  assert.equal(P.addMonths("2026-10", 14), "2027-12");
});

test("eligibleKey: nearest period that is missing or open; paid and closed are skipped", () => {
  const map = { "2026-10": { status: "closed" }, "2026-11": { status: "paid" }, "2026-12": { status: "approved" } };
  assert.equal(P.eligibleKey("2026-10", {}), "2026-10", "غير موجودة = تُنشأ");
  assert.equal(P.eligibleKey("2026-10", map), "2026-12");
  assert.equal(P.eligibleKey("2026-10", { ...map, "2026-12": { status: "closed" } }), "2027-01");
  assert.equal(P.eligibleKey("2026-10", { "2026-10": { status: "draft" } }), "2026-10");
  const allClosed = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [P.addMonths("2026-10", i), { status: "closed" }]));
  assert.throws(() => P.eligibleKey("2026-10", allClosed));
});

test("projectSettlements: oldest first, only what the salary can absorb, remainder carried (never a second advance)", () => {
  const per = period({ baseSalaryMinor: 100000, paidMinor: 0, settledMinor: 0 });
  const adv = (id, amountMinor, settledMinor = 0) => ({ _id: id, amountMinor, settledMinor });
  const fits = P.projectSettlements(per, [adv("a", 30000)]);
  assert.equal(fits.totalSettleMinor, 30000);
  assert.equal(fits.totalCarryMinor, 0);
  const over = P.projectSettlements(per, [adv("a", 150000)]);
  assert.deepEqual([over.items[0].settleMinor, over.items[0].carryMinor], [100000, 50000]);
  const two = P.projectSettlements(per, [adv("a", 70000), adv("b", 60000)]);
  assert.deepEqual(two.items.map((i) => [i.settleMinor, i.carryMinor]), [[70000, 0], [30000, 30000]]);
  // سلفة سُوِّيت جزئياً سابقاً: المتبقي منها فقط
  const partial = P.projectSettlements(period({ baseSalaryMinor: 40000 }), [adv("a", 100000, 80000)]);
  assert.deepEqual([partial.items[0].settleMinor, partial.items[0].carryMinor], [20000, 0]);
  // راتب مدفوع جزئياً: يتسع بقدر المتبقي
  const paid = P.projectSettlements(period({ baseSalaryMinor: 100000, paidMinor: 90000 }), [adv("a", 50000)]);
  assert.deepEqual([paid.items[0].settleMinor, paid.items[0].carryMinor], [10000, 40000]);
  // لا متبقي: لا تسوية والكل يُرحَّل
  const none = P.projectSettlements(period({ paidMinor: 100000 }), [adv("a", 5000)]);
  assert.deepEqual([none.totalSettleMinor, none.totalCarryMinor], [0, 5000]);
});

// ───────── تصحيحات التدقيق ─────────
const { fingerprint, assertSameRequest } = require("../../src/services/employeeLedger.service");
const { buildSummary } = require("../../src/services/employeeFinance.service");

test("isSalaryCategory: spelling variants are the salary category; ordinary categories are not", () => {
  for (const c of ["رواتب", "الرواتب", "راتب", "الراتب", "رواتب الموظفين", " رواتب ", "Salary", "SALARIES", "payroll", "الرَواتب"]) assert.equal(P.isSalaryCategory(c), true, c);
  for (const c of ["إيجار", "كهرباء وماء", "مواصلات", "تغليف", "أخرى", "", undefined, null, "رواتب إضافية للمورد"]) assert.equal(P.isSalaryCategory(c), false, String(c));
});

test("eligibilityReason: hire month, known salary month, and the current/future months", () => {
  const e = (o) => ({ hireDate: "2026-07-15T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", ...o });
  assert.equal(P.eligibilityReason(e({}), "2026-06"), "BEFORE_HIRE");
  assert.equal(P.eligibilityReason(e({}), "2026-08"), "HISTORICAL_SALARY_UNKNOWN", "بعد التعيين وقبل شهر إنشاء السجل");
  assert.equal(P.eligibilityReason(e({}), "2026-10"), null);
  assert.equal(P.eligibilityReason(e({}), "2026-11"), null, "الأشهر القادمة مسموحة (الدفع يرفضها بنفسه)");
  assert.equal(P.eligibilityReason(e({ salaryEffectiveFrom: "2026-07" }), "2026-08"), null, "تصريح صريح بسريان الراتب");
  assert.equal(P.eligibilityReason(e({ salaryEffectiveFrom: "2026-07" }), "2026-06"), "BEFORE_HIRE");
  assert.equal(P.eligibilityReason({ createdAt: "2026-10-01T00:00:00Z" }, "2026-01"), "HISTORICAL_SALARY_UNKNOWN", "بلا تاريخ تعيين: الشهر يُقاس بسريان الراتب");
  assert.equal(P.eligibilityReason({ salaryEffectiveFrom: "2026-01" }, "2026-01"), null);
});

test("current month is UTC regardless of the local timezone of the caller (month boundaries)", () => {
  assert.equal(P.currentKey(new Date("2026-10-31T23:59:59.999Z")), "2026-10");
  assert.equal(P.currentKey(new Date("2026-11-01T00:00:00.000Z")), "2026-11");
  // لحظات يراها المتصفح المحلي في شهر مختلف عن UTC: الخادم يبقى على UTC
  assert.equal(P.currentKey(new Date("2026-11-01T00:30:00+03:00")), "2026-10", "00:30 محلي في دمشق = 21:30 UTC من الشهر السابق");
  assert.equal(P.currentKey(new Date("2026-10-31T22:30:00-02:00")), "2026-11");
  assert.equal(P.currentKey(new Date("2026-12-31T23:30:00-03:00")), "2027-01");
  assert.equal(P.addMonths("2026-12", 1), "2027-01");
});

test("fingerprint: deterministic, key-order independent, sensitive to every material field", () => {
  const a = fingerprint({ op: "salary", employee: "e1", amountMinor: 100, currency: "USD", method: "cash", period: "" });
  assert.equal(a, fingerprint({ period: "", method: "cash", currency: "USD", amountMinor: 100, employee: "e1", op: "salary" }));
  for (const change of [{ employee: "e2" }, { amountMinor: 101 }, { currency: "SYP" }, { method: "other" }, { period: "2026-10" }, { op: "advance.issue" }]) {
    assert.notEqual(a, fingerprint({ op: "salary", employee: "e1", amountMinor: 100, currency: "USD", method: "cash", period: "", ...change }), JSON.stringify(change));
  }
  assert.equal(fingerprint({ a: undefined }), fingerprint({ a: null }));
  assert.doesNotThrow(() => assertSameRequest({ requestHash: a }, a));
  assert.doesNotThrow(() => assertSameRequest({}, a), "سجل قديم بلا بصمة يُقبل");
  assert.throws(() => assertSameRequest({ requestHash: a }, fingerprint({ x: 1 })), (e) => e.status === 409 && e.code === "IDEMPOTENCY_KEY_REUSED");
});

test("buildSummary: one definition of remaining payable for list and account (scenarios)", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  const e = { _id: "e1", number: "EMP-1", name: "x", nameKey: "x", currency: "USD", salaryMinor: 100000, status: "active", payDay: 1, createdAt: new Date("2026-01-01") };
  const per = (o = {}) => ({ _id: "p1", employee: "e1", periodKey: "2026-10", currency: "USD", baseSalaryMinor: 100000, allowancesMinor: 0, bonusesMinor: 0, deductionsMinor: 0, settledMinor: 0, paidMinor: 0, status: "approved", dueDate: new Date("2026-10-01"), ...o });
  const adv = (o = {}) => ({ _id: "a1", employee: "e1", currency: "USD", amountMinor: 30000, settledMinor: 0, status: "disbursed", deductionPeriod: "p1", createdAt: new Date("2026-10-02"), ref: "ADV-1", ...o });
  const S = (periods, advs, key) => buildSummary(e, periods, advs, key, now).summary;
  const none = S([per()], []);
  assert.equal(none.remainingPayable, 1000);
  assert.equal(none.advances.outstanding, 0);
  const sched = S([per()], [adv()]);
  assert.equal(sched.scheduledSettlement, 300);
  assert.equal(sched.remainingPayable, 700, "المتبقي بعد خصم السلفة المجدولة");
  assert.equal(sched.advances.outstanding, 300, "رصيد السلفة منفصل عن رصيد الراتب");
  const settled = S([per({ settledMinor: 30000, paidMinor: 40000, status: "partially_paid" })], [adv({ settledMinor: 30000, status: "settled" })]);
  assert.equal(settled.remainingPayable, 300);
  assert.equal(settled.advances.outstanding, 0);
  assert.equal(settled.settlementsApplied, 300);
  const carried = S([per({ baseSalaryMinor: 10000 }), per({ _id: "p2", periodKey: "2026-11", status: "draft" })], [adv({ amountMinor: 15000, deductionPeriod: "p1" })]);
  assert.equal(carried.scheduledSettlement, 100);
  assert.equal(carried.carryForward, 50);
  assert.equal(carried.remainingPayable, 0);
  assert.equal(carried.reason, "NO_SALARY_DUE");
  const paid = S([per({ paidMinor: 100000, status: "paid" })], []);
  assert.equal(paid.remainingPayable, 0);
  assert.equal(paid.canPay, false);
  // موظف غير فعّال: السلفة التي لا تتسع لا تُرحَّل (قرار إداري مطلوب)
  const inactive = buildSummary({ ...e, status: "terminated" }, [per({ baseSalaryMinor: 10000 })], [adv({ amountMinor: 15000 })], undefined, now).summary;
  assert.equal(inactive.reason, "INACTIVE_ADVANCE_CARRY");
  assert.equal(inactive.advances.outstanding, 150, "تبقى ظاهرة");
  // أسباب الأهلية للشهر بلا فترة
  assert.equal(buildSummary({ ...e, hireDate: new Date("2026-10-05") }, [], [], "2026-09", now).summary.reason, "BEFORE_HIRE");
  assert.equal(buildSummary({ ...e, createdAt: new Date("2026-10-01") }, [], [], "2026-09", now).summary.reason, "HISTORICAL_SALARY_UNKNOWN");
  assert.equal(buildSummary(e, [], [], "2026-11", now).summary.reason, "FUTURE_PERIOD");
});
