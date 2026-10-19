import test from "node:test";
import assert from "node:assert/strict";
import * as Utils from "../src/payrollUtils.js";
import { validateAmount, salaryFormState, openPeriods, isPeriodKey, INDICATOR, INDICATOR_TONE, LEDGER_TYPE, PERIOD_STATUS, PAY_BLOCK, SALARY_CATEGORY } from "../src/payrollUtils.js";

test("validateAmount: precision per currency, positivity and max", () => {
  assert.equal(validateAmount("USD", "100"), "");
  assert.equal(validateAmount("USD", "100.5"), "");
  assert.equal(validateAmount("USD", "100.55"), "");
  assert.match(validateAmount("USD", "100.555"), /خانتان/);
  assert.equal(validateAmount("SYP", "1500000"), "");
  assert.match(validateAmount("SYP", "10.5"), /صحيح/);
  assert.match(validateAmount("USD", ""), /مطلوب/);
  assert.match(validateAmount("USD", "abc"), /رقماً/);
  assert.match(validateAmount("USD", "0"), /أكبر من صفر/);
  assert.match(validateAmount("USD", "-5"), /أكبر من صفر/);
  assert.match(validateAmount("USD", "50", { max: 40 }), /يتجاوز/);
  assert.equal(validateAmount("USD", "40", { max: 40 }), "");
});

const summary = (o = {}) => ({ currency: "USD", canPay: true, reason: null, remainingPayable: 600, ...o });

test("salaryFormState: reads the server summary; amount defaults are the server's remaining payable", () => {
  assert.deepEqual(salaryFormState(null, "10"), { ready: false, error: "", full: false, blocked: "" });
  const full = salaryFormState(summary(), "600");
  assert.equal(full.ready, true);
  assert.equal(full.full, true);
  const part = salaryFormState(summary(), "250.5");
  assert.equal(part.ready, true);
  assert.equal(part.partial, true);
  assert.equal(part.full, false);
  const over = salaryFormState(summary(), "600.01");
  assert.equal(over.ready, false);
  assert.match(over.error, /يتجاوز/);
  assert.match(salaryFormState(summary(), "").error, /مطلوب/);
  assert.equal(salaryFormState(summary({ currency: "SYP", remainingPayable: 1000 }), "10.5").ready, false);
});

test("salaryFormState: every server block reason is explained and disables the form", () => {
  for (const reason of ["NO_SALARY_DUE", "PERIOD_CLOSED", "FUTURE_PERIOD", "EMPLOYEE_INACTIVE", "BEFORE_HIRE", "HISTORICAL_SALARY_UNKNOWN", "INACTIVE_ADVANCE_CARRY"]) {
    const st = salaryFormState(summary({ canPay: false, reason, remainingPayable: 0 }), "0");
    assert.equal(st.ready, false);
    assert.equal(st.blocked, PAY_BLOCK[reason]);
  }
  assert.match(salaryFormState(summary({ canPay: false, reason: "SOMETHING_NEW" }), "1").blocked, /لا يمكن/);
});

test("openPeriods feeds the optional deduction-period change: closed and paid periods are excluded", () => {
  const ps = [{ id: "1", status: "draft" }, { id: "2", status: "approved" }, { id: "3", status: "partially_paid" }, { id: "4", status: "paid" }, { id: "5", status: "closed" }];
  assert.deepEqual(openPeriods(ps).map((p) => p.id), ["1", "2", "3"]);
  assert.deepEqual(openPeriods(undefined), []);
});

test("period keys, salary category and labels are complete", () => {
  assert.equal(SALARY_CATEGORY, "رواتب");
  assert.equal(isPeriodKey("2026-10"), true);
  assert.equal(isPeriodKey("2026-13"), false);
  assert.equal(isPeriodKey(""), false);
  // الشهر الحالي من الخادم فقط: لا دالة محلية تخمّنه في المتصفح (كانت تختلف عن UTC عند حدود الأشهر)
  assert.equal(typeof Utils.periodKeyOf, "undefined");
  for (const k of Object.keys(INDICATOR)) assert.ok(INDICATOR_TONE[k], k);
  for (const k of ["draft", "approved", "partially_paid", "paid", "closed"]) assert.ok(PERIOD_STATUS[k]);
  for (const k of ["salary_entitlement", "advance_disbursement", "advance_settlement", "salary_payment", "allowance", "bonus", "deduction", "adjustment", "reversal"]) assert.ok(LEDGER_TYPE[k]);
});
