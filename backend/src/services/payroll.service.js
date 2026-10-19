const payrollRepo = require("../repositories/payroll.repository");
const employeeRepo = require("../repositories/employee.repository");
const advanceRepo = require("../repositories/employeeAdvance.repository");
const ledgerRepo = require("../repositories/employeeLedger.repository");
const cash = require("./cash.service");
const ledger = require("./employeeLedger.service");
const { nextSeq } = require("../repositories/counter.repository");
const { toMinorC, validAmount } = require("../utils/money");
const { parsePaging, pageResult } = require("../utils/pagination");
const { PERIOD_KEY, periodBounds, remainingPayable, eligibilityReason, OPEN_FOR_SETTLEMENT, OPEN_FOR_PAYMENT, OPEN_FOR_REVERSAL } = require("../utils/payroll");
const { badRequest, notFound, conflict } = require("../utils/errors");
const { presentPeriod, presentAdvance, presentLedger } = require("./payroll.present");
const { runAtomic } = require("../utils/unitOfWork");
const { postEntry, isKeyDup, asConflict, actorOf, fingerprint, assertSameRequest } = ledger;

// رسائل أسباب عدم أهلية الشهر (تُستعمل في إنشاء الفترة وفي ملخص الراتب)
const ELIGIBILITY_MSG = {
  BEFORE_HIRE: "لا تُنشأ فترة راتب لشهر قبل شهر تعيين الموظف.",
  HISTORICAL_SALARY_UNKNOWN: "لا يمكن إنشاء فترة لهذا الشهر: الراتب الحالي لا يصلح أساساً لشهر أقدم من سريانه المعروف. صرّح بشهر سريان الراتب على سجل الموظف (salaryEffectiveFrom) إن كان ينطبق.",
};

/**
 * الرواتب. القواعد:
 *  1) الحساب الوحيد في utils/payroll.js (والمكافئ الذرّي في الـ repository): الصافي = أساسي + بدلات + مكافآت − استقطاعات،
 *     المتبقي = الصافي − تسويات السلف − الدفعات. السلفة المصروفة لا تُخصم إلا بقيد تسوية صريح.
 *  2) كل ترحيل يبدأ بإدراج قيد الدفتر (مفتاح فريد) ثم تحديث العدّادات بشرط ذرّي ثم النقد؛ أي فشل يتراجع كل ما قبله.
 *  3) القيود المرحَّلة لا تُعدَّل ولا تُحذف: التصحيح بقيد عكسي.
 *  4) الدفع/السلفة النقدية تنشئ حركة نقد حقيقية في صندوق عملة الفترة؛ الدفع غير النقدي (method=other) لا ينشئ حركة وهمية.
 */
const amountOf = (cur, amount) => {
  if (!validAmount(cur, amount)) throw badRequest(cur === "SYP" ? "مبلغ الليرة عدد صحيح." : "مبلغ الدولار بخانتين عشريتين كحد أقصى.", "INVALID_AMOUNT_PRECISION");
  return toMinorC(cur, amount);
};
const assertCurrency = (period, currency) => {
  if (currency && currency !== period.currency) throw badRequest(`عملة العملية (${currency}) لا تطابق عملة الفترة (${period.currency}).`, "CURRENCY_MISMATCH");
};
const STATE_AR = { draft: "مسودة", approved: "معتمدة", partially_paid: "مدفوعة جزئياً", paid: "مدفوعة بالكامل", closed: "مغلقة" };

async function loadPeriod(id, ctx) {
  const p = await payrollRepo.findById(id, ctx);
  if (!p) throw notFound("فترة الراتب غير موجودة.", "PERIOD_NOT_FOUND");
  return p;
}
// تفسير فشل التحديث الذرّي المشروط برسالة دقيقة (الحالة أم تجاوز المتبقي)
const explain = (p, allowed, amountMinor, what) => {
  if (p.status === "closed") return conflict("الفترة مغلقة ولا تقبل تعديلاً عادياً.", "PERIOD_CLOSED");
  if (!allowed.includes(p.status)) return conflict(`لا يمكن ${what} والفترة ${STATE_AR[p.status]}.`, "INVALID_STATE", { status: p.status });
  return conflict(`المبلغ يتجاوز المتبقي المسموح (${remainingPayable(p) / (p.currency === "SYP" ? 1 : 100)} ${p.currency}).`, "EXCEEDS_REMAINING", { amountMinor });
};

async function createPeriod(body, actor) {
  const e = await employeeRepo.findById(body.employeeId);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  if (e.status !== "active") throw conflict("لا تُنشأ فترة راتب لموظف غير فعّال.", "EMPLOYEE_INACTIVE");
  if (!PERIOD_KEY.test(body.periodKey)) throw badRequest("مفتاح الفترة بصيغة YYYY-MM.", "INVALID_PERIOD_KEY");
  const why = eligibilityReason(e, body.periodKey);
  if (why) throw conflict(ELIGIBILITY_MSG[why], why, { periodKey: body.periodKey });
  if (body.currency && body.currency !== e.currency) throw badRequest("عملة الفترة يجب أن تطابق عملة الموظف.", "CURRENCY_MISMATCH");
  const prior = body.idempotencyKey ? await payrollRepo.findByKey(body.idempotencyKey) : null;
  if (prior) return { duplicate: true, period: presentPeriod(prior) };
  const b = periodBounds(body.periodKey, e.payDay);
  try {
    const p = await runAtomic(async (ctx) => {
      const doc = await payrollRepo.create(
        {
          ref: `PAY-${String(await nextSeq("payrollPeriod", ctx)).padStart(6, "0")}`, employee: e._id, periodKey: body.periodKey, ...b, currency: e.currency,
          baseSalaryMinor: e.salaryMinor, idempotencyKey: body.idempotencyKey, createdBy: actorOf(actor),
        },
        ctx
      );
      ctx.undo(() => payrollRepo.deleteById(doc._id));
      return doc;
    });
    return { duplicate: false, period: presentPeriod(p) };
  } catch (err) {
    if (err.code === 11000) {
      if (body.idempotencyKey) { const again = await payrollRepo.findByKey(body.idempotencyKey); if (again) return { duplicate: true, period: presentPeriod(again) }; }
      throw conflict(`توجد فترة راتب لهذا الموظف في ${body.periodKey} مسبقاً.`, "PERIOD_EXISTS");
    }
    throw err;
  }
}

async function get(id) {
  return presentPeriod(await loadPeriod(id));
}

async function listForEmployee(employeeId, q) {
  const e = await employeeRepo.findById(employeeId);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  const filter = { employee: e._id };
  if (q.status) filter.status = q.status;
  const paging = parsePaging(q, 24);
  const { items, total } = await payrollRepo.list(filter, paging);
  return pageResult(items.map((p) => presentPeriod(p)), total, paging);
}

/** ملخص الفترة: الأرقام + قيودها + السلف المسنَدة إليها + تسويات السلف (للشاشة التفصيلية) */
async function summary(id) {
  const p = await loadPeriod(id);
  const [entries, advances] = await Promise.all([ledgerRepo.byPeriod(p._id), advanceRepo.byPeriod(p._id)]);
  const keys = { [String(p._id)]: p.periodKey };
  return {
    period: presentPeriod(p),
    ledger: entries.map((l) => presentLedger(l, keys)),
    advances: advances.map((a) => presentAdvance(a, keys)),
    settlements: entries.filter((l) => l.type === "advance_settlement").map((l) => presentLedger(l, keys)),
    payments: entries.filter((l) => l.type === "salary_payment").map((l) => presentLedger(l, keys)),
  };
}

/** اعتماد داخل وحدة ذرّية قائمة (يُستعمل من الاعتماد المباشر ومن الإغلاق/الدفع): قيد الاستحقاق ثم الحالة، ويتراجعان معاً عند أي فشل لاحق */
async function approveInCtx(p, actor, ctx) {
  if (p.baseSalaryMinor > 0) await postEntry({ employee: p.employee, period: p._id, type: "salary_entitlement", currency: p.currency, amountMinor: p.baseSalaryMinor, date: new Date(), note: `استحقاق راتب ${p.periodKey}`, key: `payapprove:${p._id}`, actor }, ctx);
  const updated = await payrollRepo.approve(p._id, actorOf(actor), ctx);
  if (!updated) throw conflict("اعتُمدت هذه الفترة مسبقاً.", "INVALID_STATE");
  ctx.undo(() => payrollRepo.undoApprove(p._id));
  return updated;
}

async function approve(id, actor) {
  const p = await loadPeriod(id);
  if (p.status !== "draft") throw conflict(`الفترة ${STATE_AR[p.status]} ولا يمكن اعتمادها.`, "INVALID_STATE", { status: p.status });
  try {
    const out = await runAtomic((ctx) => approveInCtx(p, actor, ctx));
    return { period: presentPeriod(out) };
  } catch (err) {
    if (isKeyDup(err)) throw conflict("اعتُمدت هذه الفترة مسبقاً.", "INVALID_STATE");
    throw err;
  }
}

const KIND = { allowance: { field: "allowancesMinor", sign: 1, what: "إضافة بدل" }, bonus: { field: "bonusesMinor", sign: 1, what: "إضافة مكافأة" }, deduction: { field: "deductionsMinor", sign: 1, what: "تسجيل استقطاع" } };

/** بدل/مكافأة/استقطاع: في المسودة فقط، وبعد الاعتماد تُقفل مكوّنات الراتب */
async function addAdjustment(id, body, actor) {
  const p = await loadPeriod(id);
  assertCurrency(p, body.currency);
  const k = KIND[body.kind];
  const amountMinor = amountOf(p.currency, body.amount);
  const key = `payadj:${body.idempotencyKey}`;
  const hash = fingerprint({ op: "adjust", period: String(p._id), kind: body.kind, amountMinor });
  const prior = await ledgerRepo.findByKey(key);
  if (prior) { assertSameRequest(prior, hash); return { duplicate: true, entry: presentLedger(prior), period: presentPeriod(await loadPeriod(id)) }; }
  try {
    const out = await runAtomic(async (ctx) => {
      const e = await postEntry({ employee: p.employee, period: p._id, type: body.kind, currency: p.currency, amountMinor, date: body.date, note: body.note, key, actor, requestHash: hash }, ctx);
      const delta = { [k.field]: amountMinor };
      const updated = await payrollRepo.adjustComponent(p._id, delta, ctx);
      if (!updated) throw explain(await loadPeriod(id, ctx), ["draft"], amountMinor, k.what + " (متاح قبل أول دفعة أو تسوية فقط)");
      ctx.undo(() => payrollRepo.undoAdjust(p._id, delta));
      return { e, updated };
    });
    return { duplicate: false, entry: presentLedger(out.e), period: presentPeriod(out.updated) };
  } catch (err) {
    if (isKeyDup(err)) { const again = await ledgerRepo.findByKey(key); assertSameRequest(again, hash); return { duplicate: true, entry: presentLedger(again), period: presentPeriod(await loadPeriod(id)) }; }
    throw err;
  }
}

/** عكس قيد مرحَّل (دفعة/تسوية/بدل/مكافأة/استقطاع) بقيد عكسي وإرجاع أثره على العدّادات والنقد. الأصل لا يُحذف */
async function reverseEntry(entryId, { reason, expect, actor }) {
  const orig = await ledgerRepo.findById(entryId);
  if (!orig || !expect.includes(orig.type)) throw notFound("القيد غير موجود.", "ENTRY_NOT_FOUND");
  if (orig.reversedBy) throw conflict("هذا القيد معكوس مسبقاً.", "ALREADY_REVERSED");
  const p = await loadPeriod(orig.period);
  const delta = { [require("../utils/payroll").COUNTER_OF[orig.type]]: -orig.amountMinor };
  const isComponent = ["allowance", "bonus", "deduction"].includes(orig.type);
  const statuses = isComponent ? ["draft"] : OPEN_FOR_REVERSAL;
  try {
    const rev = await runAtomic(async (ctx) => {
      const r = await postEntry({ employee: orig.employee, period: orig.period, advance: orig.advance, type: "reversal", reverseOf: orig.type, reverses: orig._id, currency: orig.currency, amountMinor: orig.amountMinor, note: `عكس ${orig.ref}: ${reason}`, key: `entrev:${orig._id}`, actor }, ctx);
      const marked = await ledgerRepo.markReversed(orig._id, r._id, ctx);
      if (!marked) throw conflict("هذا القيد معكوس مسبقاً.", "ALREADY_REVERSED");
      ctx.undo(() => ledgerRepo.unmarkReversed(orig._id));
      if (orig.type === "advance_settlement") {
        const a = await advanceRepo.unsettle(orig.advance, orig.amountMinor, ctx);
        if (!a) throw conflict("تعذّر إرجاع التسوية على السلفة (حالتها لا تسمح).", "INVALID_STATE");
        ctx.undo(() => advanceRepo.undoUnsettle(orig.advance, orig.amountMinor));
      }
      const updated = isComponent ? await payrollRepo.adjustComponent(p._id, delta, ctx) : await payrollRepo.adjust(p._id, delta, statuses, ctx);
      if (!updated) throw explain(await loadPeriod(p._id, ctx), statuses, orig.amountMinor, "عكس هذا القيد");
      ctx.undo(() => payrollRepo.undoAdjust(p._id, delta));
      if (orig.expense) await cash.reverseExpenseInCtx(orig.expense, `عكس ${orig.ref}: ${reason}`, actor, ctx); // دفعة راتب عبر المصروفات: يُعكس المصروف وحركته النقدية معاً
      else if (orig.cash) await cash.reverseSource("payroll_payment", orig._id, { type: "payroll_reversal", note: `عكس ${orig.ref}: ${reason}`, actor, keyPrefix: "salpayrev" }, ctx);
      return r;
    });
    return { entry: presentLedger(rev), period: presentPeriod(await loadPeriod(p._id)) };
  } catch (err) {
    return asConflict(err, "هذا القيد معكوس مسبقاً.", "ALREADY_REVERSED");
  }
}
const reversePayment = (periodId, entryId, body, actor) => assertEntryOfPeriod(periodId, entryId).then(() => reverseEntry(entryId, { reason: body.reason, expect: ["salary_payment"], actor }));
const reverseAdjustment = (periodId, entryId, body, actor) => assertEntryOfPeriod(periodId, entryId).then(() => reverseEntry(entryId, { reason: body.reason, expect: ["allowance", "bonus", "deduction"], actor }));
async function assertEntryOfPeriod(periodId, entryId) {
  const e = await ledgerRepo.findById(entryId);
  if (!e || String(e.period) !== String(periodId)) throw notFound("القيد غير موجود في هذه الفترة.", "ENTRY_NOT_FOUND");
}

/** تحقق شروط الإغلاق (داخل وحدة ذرّية قائمة): مدفوعة بالكامل ولا سلف مفتوحة، ثم تحديث الحالة بشرط. الإغلاق الفعلي من employeeFinance.closePeriod */
async function closeInCtx(p, actor, ctx) {
  if (p.status === "closed") throw conflict("الفترة مغلقة مسبقاً.", "PERIOD_CLOSED");
  if (p.status !== "paid") throw conflict(`لا تُغلق إلا فترة مدفوعة بالكامل (الحالية: ${STATE_AR[p.status]}، المتبقي ${remainingPayable(p) / (p.currency === "SYP" ? 1 : 100)}).`, "INVALID_STATE", { status: p.status });
  const open = await advanceRepo.openByPeriod(p._id, ctx);
  if (open.length) throw conflict("توجد سلف غير مسوّاة مسنَدة لهذه الفترة: سوِّها أو أعد إسنادها قبل الإغلاق.", "ADVANCES_OPEN", { advances: open.map((a) => a.ref) });
  const closed = await payrollRepo.close(p._id, actorOf(actor), ctx);
  if (!closed) throw conflict("تعذّر الإغلاق: تغيّرت حالة الفترة.", "INVALID_STATE");
  return closed;
}

module.exports = { createPeriod, get, listForEmployee, summary, approve, approveInCtx, addAdjustment, reversePayment, reverseAdjustment, reverseEntry, closeInCtx, loadPeriod, explain, assertCurrency, amountOf, STATE_AR, ELIGIBILITY_MSG };
