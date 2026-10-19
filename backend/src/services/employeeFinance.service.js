const employeeRepo = require("../repositories/employee.repository");
const payrollRepo = require("../repositories/payroll.repository");
const advanceRepo = require("../repositories/employeeAdvance.repository");
const ledgerRepo = require("../repositories/employeeLedger.repository");
const cash = require("./cash.service");
const payroll = require("./payroll.service");
const advances = require("./employeeAdvance.service");
const { postEntry, isKeyDup, fingerprint, assertSameRequest } = require("./employeeLedger.service");
const { fromMinorC } = require("../utils/money");
const { currentKey, addMonths, eligibleKey, OPEN_STATUSES, projectSettlements, netEntitlement, remainingPayable, advanceOutstanding, indicator, isSalaryCategory, eligibilityReason, OPEN_FOR_SETTLEMENT, OPEN_FOR_PAYMENT } = require("../utils/payroll");
const { SALARY_EXPENSE_CATEGORY } = require("../config/constants");
const { badRequest, notFound, conflict } = require("../utils/errors");
const { runAtomic } = require("../utils/unitOfWork");
const { presentEmployee, presentAdvance, presentPeriod, presentLedger } = require("./payroll.present");

/**
 * واجهة الموظف المالية (مصدر وحيد لكل مدخل: واجهة الموظف، المالية ← المصروفات، وواجهة الدفع القديمة منخفضة المستوى):
 *  1) الفترة شهرية (YYYY-MM بتوقيت UTC، والخادم هو المرجع الوحيد للشهر الحالي) وتُنشأ عند الحاجة وتُعتمد داخل وحدة الدفع الذرّية نفسها.
 *  2) المتبقي للدفع = صافي الاستحقاق − التسويات المطبَّقة − الدفعات − التسويات المجدولة. buildSummary هي الحساب الوحيد
 *     (يستعملها الملخص وقائمة الموظفين معاً فلا تختلف الأرقام).
 *  3) عند أول دفعة تُسوّى السلف المجدولة (الأقدم أولاً) بقدر ما يتسع له الراتب، والباقي يُرحَّل للشهر الصالح التالي.
 *  4) لا فترة قبل شهر التعيين، ولا قبل شهر سريان الراتب المعروف (لا لقطة راتب تاريخية مخترعة).
 *  5) كل عملية مرحَّلة مربوطة بمفتاح تكرار وبصمة طلب: المفتاح نفسه بمعطيات مختلفة = 409.
 */
const SALARY = SALARY_EXPENSE_CATEGORY;

const INACTIVE_CARRY_MSG = "الموظف غير فعّال وسلفته المجدولة تتجاوز الراتب المتبقي فلا يمكن ترحيلها إلى شهر جديد. يلزم قرار إداري (إعادة تفعيل الموظف أو معالجة السلفة يدوياً)؛ السلفة تبقى ظاهرة في رصيده.";

async function loadEmployee(id) {
  const e = await employeeRepo.findById(id);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  return e;
}
const periodMap = async (employeeId) => Object.fromEntries((await payrollRepo.byEmployee(employeeId)).map((p) => [p.periodKey, p]));

/** فترة الشهر للموظف: تُنشأ (مسودة بلقطة الراتب الحالي) إن لم توجد وكان الشهر مؤهَّلاً، وآمنة تحت التزامن */
async function ensurePeriod(employee, key, actor) {
  const found = await payrollRepo.findByEmployeeAndKey(employee._id, key);
  if (found) return found;
  try {
    await payroll.createPeriod({ employeeId: String(employee._id), periodKey: key }, actor);
  } catch (e) {
    if (e.code !== "PERIOD_EXISTS") throw e;
  }
  return payrollRepo.findByEmployeeAndKey(employee._id, key);
}

// الفترة الافتراضية لدفع الراتب: أقدم فترة مفتوحة عليها متبقٍ (حتى الشهر الحالي)، وإلا الشهر الحالي
function defaultSalaryKey(map, now = new Date()) {
  const cur = currentKey(now);
  const open = Object.values(map).filter((p) => OPEN_STATUSES.includes(p.status) && p.periodKey <= cur && remainingPayable(p) > 0).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
  return open[0]?.periodKey || cur;
}

/**
 * الحساب الوحيد لملخص الموظف (دالة نقية بلا I/O): المدخلات سجلات محمَّلة، والمخرجات أرقام بوحدات العملة الكبرى.
 * يستعملها summary (حساب الموظف) وقائمة الموظفين، فلا تختلف الأرقام بين الشاشات.
 */
function buildSummary(e, periods, allAdv, requestedKey, now = new Date()) {
  const cur = currentKey(now);
  const map = Object.fromEntries(periods.map((p) => [p.periodKey, p]));
  const key = requestedKey || defaultSalaryKey(map, now);
  const p = map[key] || null;
  const base = p || { baseSalaryMinor: e.salaryMinor, allowancesMinor: 0, bonusesMinor: 0, deductionsMinor: 0, settledMinor: 0, paidMinor: 0, status: null };
  const m = (v) => fromMinorC(e.currency, v || 0);
  const inPeriod = p ? allAdv.filter((a) => String(a.deductionPeriod) === String(p._id)) : [];
  const sched = inPeriod.filter((a) => ["disbursed", "partially_settled"].includes(a.status)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const plan = p ? projectSettlements(base, sched) : { items: [], totalSettleMinor: 0, totalCarryMinor: 0 };
  const remainingBefore = remainingPayable(base);
  const payable = Math.max(remainingBefore - plan.totalSettleMinor, 0);
  let reason = null;
  const ineligible = p ? null : eligibilityReason(e, key);
  if (p?.status === "closed") reason = "PERIOD_CLOSED";
  else if (!p && e.status !== "active") reason = "EMPLOYEE_INACTIVE";
  else if (key > cur) reason = "FUTURE_PERIOD";
  else if (ineligible) reason = ineligible;
  else if (e.status !== "active" && plan.totalCarryMinor > 0) reason = "INACTIVE_ADVANCE_CARRY";
  else if (payable <= 0) reason = "NO_SALARY_DUE";
  const open = allAdv.filter((a) => ["disbursed", "partially_settled"].includes(a.status));
  const keyOf = Object.fromEntries(periods.map((x) => [String(x._id), x.periodKey]));
  let defaultAdvanceKey = null;
  try { defaultAdvanceKey = eligibleKey(cur, map); } catch { /* لا فترة صالحة خلال الأفق */ }
  const nextDue = periods.filter((x) => ["draft", "approved", "partially_paid"].includes(x.status)).map((x) => x.dueDate).sort((a, b) => new Date(a) - new Date(b))[0] || null;
  const summary = {
    employee: presentEmployee(e), currency: e.currency, periodKey: key, periodExists: !!p, status: p?.status || null, closed: p?.status === "closed",
    entitlement: m(netEntitlement(base)), baseSalary: m(base.baseSalaryMinor), allowances: m(base.allowancesMinor), bonuses: m(base.bonusesMinor), deductions: m(base.deductionsMinor),
    paid: m(base.paidMinor), settlementsApplied: m(base.settledMinor), scheduledSettlement: m(plan.totalSettleMinor), carryForward: m(plan.totalCarryMinor),
    remainingBeforeSettlement: m(remainingBefore), remainingPayable: m(payable), canPay: !reason, reason,
    advances: {
      outstanding: m(open.reduce((n, a) => n + advanceOutstanding(a), 0)), outstandingCount: open.length,
      pending: m(allAdv.filter((a) => a.status === "pending").reduce((n, a) => n + a.amountMinor, 0)),
      scheduledInPeriod: m(sched.reduce((n, a) => n + advanceOutstanding(a), 0)), settledInPeriod: m(base.settledMinor),
      items: allAdv.filter((a) => ["pending", "disbursed", "partially_settled"].includes(a.status)).map((a) => presentAdvance(a, keyOf)),
    },
    defaultAdvancePeriodKey: defaultAdvanceKey, nextDueDate: nextDue, indicator: indicator(p, now),
    periods: periods.slice().sort((a, b) => b.periodKey.localeCompare(a.periodKey)).map((x) => ({ id: String(x._id), periodKey: x.periodKey, status: x.status })),
    currentKey: cur,
  };
  return { summary, period: p ? presentPeriod(p, now) : null };
}

/** ملخص الفترة الموثوق (الواجهة لا تحسب أي إجمالي). القراءة لا تُنشئ فترة */
async function summary(employeeId, requestedKey) {
  const e = await loadEmployee(employeeId);
  const [periods, adv] = await Promise.all([payrollRepo.byEmployee(e._id), advanceRepo.byEmployee(e._id)]);
  return buildSummary(e, periods, adv, requestedKey).summary;
}

async function nextEligiblePeriod(employee, afterKey, actor) {
  const map = await periodMap(employee._id);
  return ensurePeriod(employee, eligibleKey(addMonths(afterKey, 1), map), actor);
}

/**
 * تسوية السلف المجدولة على فترة داخل وحدة ذرّية قائمة: تُسوّى بقدر ما يتسع له المتبقي من الراتب، والباقي يُرحَّل للفترة التالية.
 * لموظف غير فعّال لا يُرحَّل شيء (لا فترة جديدة): يُرفض قبل أي كتابة فتبقى السلفة ظاهرة ولا تُشطب.
 * مفاتيح القيود حتمية (سلفة، فترة، رقم المحاولة) فلا تتكرر التسوية مهما أُعيد الطلب أو تزامن.
 */
async function settleScheduled(employee, periodId, actor, ctx) {
  const period = await payrollRepo.findById(periodId, ctx);
  if (!period || !OPEN_FOR_SETTLEMENT.includes(period.status)) return { settledMinor: 0, carriedMinor: 0 };
  const sched = (await advanceRepo.openByPeriod(period._id, ctx)).filter((a) => ["disbursed", "partially_settled"].includes(a.status)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const plan = projectSettlements(period, sched);
  if (plan.totalCarryMinor > 0 && employee.status !== "active") throw conflict(INACTIVE_CARRY_MSG, "INACTIVE_ADVANCE_CARRY");
  for (const it of plan.items) {
    const a = it.advance;
    const n = (await ledgerRepo.byAdvance(a._id)).length;
    if (it.settleMinor > 0) {
      await postEntry({ employee: a.employee, period: period._id, advance: a._id, type: "advance_settlement", currency: a.currency, amountMinor: it.settleMinor, note: `تسوية تلقائية للسلفة ${a.ref} من راتب ${period.periodKey}`, key: `autoset:${a._id}:${period._id}:${n}`, actor }, ctx);
      const adv = await advanceRepo.settle(a._id, it.settleMinor, ctx);
      if (!adv) throw conflict("تعذّرت تسوية السلفة: تغيّر رصيدها.", "OVER_SETTLEMENT");
      ctx.undo(() => advanceRepo.undoSettle(a._id, it.settleMinor));
      const delta = { settledMinor: it.settleMinor };
      const per = await payrollRepo.adjust(period._id, delta, OPEN_FOR_SETTLEMENT, ctx);
      if (!per) throw payroll.explain(await payroll.loadPeriod(period._id, ctx), OPEN_FOR_SETTLEMENT, it.settleMinor, "تسوية سلفة");
      ctx.undo(() => payrollRepo.undoAdjust(period._id, delta));
    }
    if (it.carryMinor > 0) {
      const next = await nextEligiblePeriod(employee, period.periodKey, actor);
      const moved = await advanceRepo.carryForward(a._id, period._id, next._id, ctx);
      if (!moved) throw conflict("تعذّر ترحيل السلفة: تغيّرت حالتها.", "INVALID_STATE");
      ctx.undo(() => advanceRepo.carryForward(a._id, next._id, period._id));
      await postEntry({ employee: a.employee, period: next._id, advance: a._id, type: "adjustment", currency: a.currency, amountMinor: it.carryMinor, note: `ترحيل رصيد السلفة ${a.ref} غير المسوّاة من ${period.periodKey} إلى ${next.periodKey}`, key: `carry:${a._id}:${period._id}:${n}`, actor }, ctx);
    }
  }
  return { settledMinor: plan.totalSettleMinor, carriedMinor: plan.totalCarryMinor };
}

/** تطبيق خصم السلف المجدولة الآن (دون دفع): الاعتماد (إن كانت مسودة) والتسوية والترحيل في وحدة واحدة */
async function applyScheduledSettlements(employeeId, body, actor) {
  const e = await loadEmployee(employeeId);
  const map = await periodMap(e._id);
  const key = body.periodKey || defaultSalaryKey(map);
  const p = map[key];
  if (!p) throw notFound("لا توجد فترة لهذا الشهر.", "PERIOD_NOT_FOUND");
  if (p.status === "closed") throw conflict("الفترة مغلقة ولا تقبل تعديلاً عادياً.", "PERIOD_CLOSED");
  try {
    const done = await runAtomic(async (ctx) => {
      const cur = await payrollRepo.findById(p._id, ctx);
      if (cur.status === "draft") await payroll.approveInCtx(cur, actor, ctx);
      return settleScheduled(e, p._id, actor, ctx);
    });
    return { ...done, summary: await summary(e._id, key) };
  } catch (err) {
    if (isKeyDup(err)) throw conflict("عملية أخرى على هذا الموظف قيد التنفيذ. أعد المحاولة.", "CONCURRENT_UPDATE");
    throw err;
  }
}

const duplicate = async (prior, employeeId, hash) => {
  assertSameRequest(prior, hash);
  // قيد جديد لم يكتمل ربطه بالمصروف = عملية أخرى بالمفتاح نفسه ما زالت قيد التنفيذ (قد تتراجع): لا نعلن نجاحاً بل نطلب إعادة المحاولة
  if (prior.requestHash && !prior.expense) throw conflict("العملية نفسها قيد التنفيذ الآن. أعد المحاولة بعد لحظات.", "CONCURRENT_UPDATE");
  return { duplicate: true, expense: prior.expense ? await cash.getExpense(prior.expense) : null, entryId: String(prior._id), summary: await summary(employeeId, undefined) };
};

/** دفع راتب عبر المالية ← المصروفات: مصروف + حركة نقد (إن كان نقداً) + قيد دفتر + عدّادات الفترة في وحدة ذرّية واحدة */
async function paySalaryExpense(body, actor) {
  if (!isSalaryCategory(body.category)) throw badRequest("اختيار الموظف متاح لفئة الرواتب فقط.", "EMPLOYEE_ONLY_FOR_SALARY");
  if (!body.employeeId) throw badRequest("اختر الموظف لمصروف الراتب.", "EMPLOYEE_REQUIRED");
  const e = await loadEmployee(body.employeeId);
  if (body.currency && body.currency !== e.currency) throw badRequest(`عملة المصروف (${body.currency}) لا تطابق عملة الموظف (${e.currency}).`, "CURRENCY_MISMATCH");
  const amountMinor = payroll.amountOf(e.currency, body.amount);
  const method = body.method || "cash";
  const key = `salpay:${body.idempotencyKey}`;
  const hash = fingerprint({ op: "salary", employee: String(e._id), amountMinor, currency: e.currency, method, period: body.periodKey || "" });
  const prior = await ledgerRepo.findByKey(key);
  if (prior) return duplicate(prior, e._id, hash);
  const cur = currentKey();
  if (body.periodKey && body.periodKey > cur) throw badRequest("لا يُدفع راتب فترة مستقبلية.", "FUTURE_PERIOD");
  const map = await periodMap(e._id);
  const p = await ensurePeriod(e, body.periodKey || defaultSalaryKey(map), actor);
  if (p.status === "closed") throw conflict("الفترة مغلقة ولا تقبل تعديلاً عادياً.", "PERIOD_CLOSED");
  try {
    const out = await runAtomic(async (ctx) => {
      const entry = await postEntry({ employee: e._id, period: p._id, type: "salary_payment", currency: e.currency, amountMinor, date: body.date, note: body.description || `راتب ${p.periodKey}`, key, actor, requestHash: hash }, ctx);
      const fresh = await payrollRepo.findById(p._id, ctx);
      if (fresh.status === "draft") await payroll.approveInCtx(fresh, actor, ctx); // الاعتماد التلقائي ضمن الوحدة نفسها: يتراجع مع أي فشل
      await settleScheduled(e, p._id, actor, ctx);
      const delta = { paidMinor: amountMinor };
      const updated = await payrollRepo.adjust(p._id, delta, OPEN_FOR_PAYMENT, ctx);
      if (!updated) {
        const now = await payroll.loadPeriod(p._id, ctx);
        if (now.status !== "closed" && remainingPayable(now) <= 0) throw conflict("لا يوجد راتب مستحق لهذه الفترة.", "NO_SALARY_DUE");
        throw payroll.explain(now, OPEN_FOR_PAYMENT, amountMinor, "تسجيل دفعة");
      }
      ctx.undo(() => payrollRepo.undoAdjust(p._id, delta));
      const { expense, movement } = await cash.postExpense(
        { currency: e.currency, amountMinor, category: SALARY, description: body.description || `راتب ${e.name} · ${p.periodKey}`, date: body.date, idempotencyKey: `salexp:${body.idempotencyKey}`, noCash: method === "other", extra: { employee: e._id, periodKey: p.periodKey, payrollEntry: entry._id, method }, actor },
        ctx
      );
      await ledgerRepo.setLinks(entry._id, { expense: expense._id, ...(movement ? { cash: movement._id } : {}) }, ctx);
      return { expense, entry };
    });
    return { duplicate: false, expense: cash.presentExpense(out.expense), entryId: String(out.entry._id), summary: await summary(e._id, p.periodKey) };
  } catch (err) {
    if (isKeyDup(err)) {
      const again = await ledgerRepo.findByKey(key);
      if (again) return duplicate(again, e._id, hash);
      throw conflict("عملية أخرى على هذا الموظف قيد التنفيذ. أعد المحاولة.", "CONCURRENT_UPDATE");
    }
    throw err;
  }
}

/**
 * واجهة الدفع القديمة (POST /payroll-periods/:id/payments): لا تنفّذ دفعاً بمنطق خاص، بل تمرّ بالخدمة نفسها (مصروف + نقد + تسوية سلف + قيد دفتر).
 * تحافظ على عقدها القديم: الفترة يجب أن تكون معتمدة (لا اعتماد تلقائي من هذه الواجهة)، والاستجابة { duplicate, entry, period }.
 */
async function payPeriod(periodId, body, actor) {
  const p = await payroll.loadPeriod(periodId);
  if (p.status === "draft") throw conflict(`لا يمكن تسجيل دفعة والفترة ${payroll.STATE_AR.draft}: اعتمدها أولاً.`, "INVALID_STATE", { status: "draft" });
  const out = await paySalaryExpense({ category: SALARY, employeeId: String(p.employee), periodKey: p.periodKey, amount: body.amount, currency: body.currency, method: body.method, description: body.note, date: body.date, idempotencyKey: body.idempotencyKey }, actor);
  const entry = await ledgerRepo.findById(out.entryId);
  return { duplicate: out.duplicate, entry: presentLedger(entry), period: presentPeriod(await payroll.loadPeriod(periodId)), expense: out.expense };
}

/** عكس مصروف راتب: يعكس قيد دفعة الراتب (والمصروف وحركته النقدية) ويعيد المتبقي للفترة */
async function reverseSalaryExpense(expense, { reason }, actor) {
  const entry = await ledgerRepo.findByExpense(expense._id);
  if (!entry) throw conflict("لا يوجد قيد راتب مرتبط بهذا المصروف.", "ENTRY_NOT_FOUND");
  await payroll.reverseEntry(String(entry._id), { reason, expect: ["salary_payment"], actor });
  return { expense: await cash.getExpense(expense._id) };
}

/** تسجيل سلفة من حساب الموظف: إنشاء + صرف في خطوة واحدة. فترة الخصم افتراضياً أقرب فترة صالحة (غير مغلقة ولا مدفوعة) ويمكن تغييرها صراحةً */
async function issueAdvance(body, actor) {
  const e = await loadEmployee(body.employeeId);
  if (body.currency && body.currency !== e.currency) throw badRequest("عملة السلفة يجب أن تطابق عملة الموظف.", "CURRENCY_MISMATCH");
  const amountMinor = payroll.amountOf(e.currency, body.amount);
  const method = body.method || "cash";
  const hash = fingerprint({ op: "advance.issue", employee: String(e._id), amountMinor, currency: e.currency, method, period: body.deductionPeriodKey || body.deductionPeriodId || "" });
  let period;
  const prior = await advanceRepo.findByKey(body.idempotencyKey);
  if (prior) period = await payrollRepo.findById(prior.deductionPeriod); // إعادة طلب: لا تُنشأ فترة ولا يُعاد اختيارها؛ البصمة تُفحص في create
  else if (body.deductionPeriodId) period = await payrollRepo.findById(body.deductionPeriodId);
  else {
    let k = body.deductionPeriodKey;
    if (!k) {
      try { k = eligibleKey(currentKey(), await periodMap(e._id)); } catch { throw conflict("لا توجد فترة صالحة لخصم السلفة.", "NO_ELIGIBLE_PERIOD"); }
    }
    period = await ensurePeriod(e, k, actor);
  }
  if (!period) throw notFound("فترة الخصم غير موجودة.", "PERIOD_NOT_FOUND");
  const created = await advances.create({ employeeId: String(e._id), amount: body.amount, deductionPeriodId: String(period._id), note: body.note, date: body.date, idempotencyKey: body.idempotencyKey }, actor, { requestHash: hash });
  const disb = await advances.disburse(created.advance.id, { method, date: body.date, note: body.note }, actor);
  return { duplicate: created.duplicate && disb.duplicate, advance: disb.advance, deductionPeriodKey: disb.advance.deductionPeriodKey || period.periodKey };
}

/** بدل/مكافأة/استقطاع على فترة الشهر (تُنشأ تلقائياً): قبل أول دفعة أو تسوية فقط */
async function addAdjustment(employeeId, body, actor) {
  const e = await loadEmployee(employeeId);
  const p = await ensurePeriod(e, body.periodKey || currentKey(), actor);
  return payroll.addAdjustment(String(p._id), { kind: body.kind, amount: body.amount, currency: body.currency, note: body.note, date: body.date, idempotencyKey: body.idempotencyKey }, actor);
}

/**
 * إغلاق فترة: اعتماد (إن كانت مسودة) + تسوية السلف المجدولة وترحيلها + التحقق + الإغلاق، كلها وحدة ذرّية واحدة.
 * أي فشل في أي مرحلة يتراجع كاملاً (معاملة حقيقية على replica set، أو تراجع تعويضي على standalone): لا إغلاق جزئي ولا خصم جزئي.
 */
async function closePeriod(employeeId, body, actor) {
  const e = await loadEmployee(employeeId);
  const p0 = await payrollRepo.findByEmployeeAndKey(e._id, body.periodKey);
  if (!p0) throw notFound("لا توجد فترة لهذا الشهر.", "PERIOD_NOT_FOUND");
  if (p0.status === "closed") throw conflict("الفترة مغلقة مسبقاً.", "PERIOD_CLOSED");
  try {
    const closed = await runAtomic(async (ctx) => {
      let p = await payrollRepo.findById(p0._id, ctx);
      if (p.status === "draft") p = await payroll.approveInCtx(p, actor, ctx);
      await settleScheduled(e, p._id, actor, ctx);
      p = await payrollRepo.findById(p._id, ctx);
      return payroll.closeInCtx(p, actor, ctx);
    });
    return { period: presentPeriod(closed) };
  } catch (err) {
    if (isKeyDup(err)) throw conflict("عملية أخرى على هذا الموظف قيد التنفيذ. أعد المحاولة.", "CONCURRENT_UPDATE");
    throw err;
  }
}

module.exports = { summary, buildSummary, defaultSalaryKey, paySalaryExpense, payPeriod, reverseSalaryExpense, issueAdvance, addAdjustment, closePeriod, applyScheduledSettlements, settleScheduled, ensurePeriod, SALARY };
