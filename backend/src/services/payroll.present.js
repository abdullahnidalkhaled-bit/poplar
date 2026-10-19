const { fromMinorC } = require("../utils/money");
const { netEntitlement, remainingPayable, advanceOutstanding, indicator } = require("../utils/payroll");

// عرض موحّد: كل المبالغ تُحوَّل من الوحدة الصغرى إلى الكبرى بعملة السجل نفسها، والمشتقات (الصافي/المتبقي) تُحسب هنا فقط
// بنفس معادلة utils/payroll.js فلا يحسب العميل أي إجمالي مالي بنفسه.
const m = (cur, v) => fromMinorC(cur, v || 0);
const id = (x) => (x ? String(x._id || x) : null);

const presentEmployee = (e) => ({
  id: id(e), number: e.number, name: e.name, jobTitle: e.jobTitle || "", phone: e.phone || "", hireDate: e.hireDate || null, status: e.status,
  userId: id(e.user), salary: m(e.currency, e.salaryMinor), currency: e.currency, payDay: e.payDay, salaryEffectiveFrom: e.salaryEffectiveFrom || null, notes: e.notes || "", createdAt: e.createdAt, updatedAt: e.updatedAt,
});

const presentPeriod = (p, now = new Date()) => {
  const c = p.currency;
  return {
    id: id(p), ref: p.ref, employeeId: id(p.employee), periodKey: p.periodKey, start: p.start, end: p.end, dueDate: p.dueDate, currency: c,
    baseSalary: m(c, p.baseSalaryMinor), allowances: m(c, p.allowancesMinor), bonuses: m(c, p.bonusesMinor), deductions: m(c, p.deductionsMinor),
    advanceSettlements: m(c, p.settledMinor), net: m(c, netEntitlement(p)), paid: m(c, p.paidMinor), remaining: m(c, remainingPayable(p)),
    status: p.status, indicator: indicator(p, now), approvedAt: p.approvedAt || null, approvedBy: p.approvedBy?.name || "", closedAt: p.closedAt || null, closedBy: p.closedBy?.name || "",
    createdAt: p.createdAt,
  };
};

const presentAdvance = (a, periodKeys = {}) => ({
  id: id(a), ref: a.ref, employeeId: id(a.employee), currency: a.currency, amount: m(a.currency, a.amountMinor), settled: m(a.currency, a.settledMinor),
  outstanding: m(a.currency, advanceOutstanding(a)), status: a.status, deductionPeriodId: id(a.deductionPeriod), deductionPeriodKey: periodKeys[id(a.deductionPeriod)] || null,
  requestedDate: a.requestedDate, disbursement: a.disbursement?.at ? { at: a.disbursement.at, method: a.disbursement.method, cashId: id(a.disbursement.cash), by: a.disbursement.by?.name || "" } : null,
  reversal: a.reversal?.at ? { at: a.reversal.at, reason: a.reversal.reason, by: a.reversal.by?.name || "" } : null, note: a.note || "", createdBy: a.createdBy?.name || "", createdAt: a.createdAt,
});

const presentLedger = (l, periodKeys = {}) => ({
  id: id(l), ref: l.ref, type: l.type, reverseOf: l.reverseOf || null, currency: l.currency, amount: m(l.currency, l.amountMinor), date: l.date, note: l.note || "",
  periodId: id(l.period), periodKey: periodKeys[id(l.period)] || null, advanceId: id(l.advance), cashId: id(l.cash), expenseId: id(l.expense), reverses: id(l.reverses),
  state: l.type === "reversal" ? "reversal" : l.reversedBy ? "reversed" : "posted", createdBy: l.createdBy?.name || "", createdAt: l.createdAt,
});

module.exports = { presentEmployee, presentPeriod, presentAdvance, presentLedger };
