const advanceRepo = require("../repositories/employeeAdvance.repository");
const payrollRepo = require("../repositories/payroll.repository");
const employeeRepo = require("../repositories/employee.repository");
const ledgerRepo = require("../repositories/employeeLedger.repository");
const cash = require("./cash.service");
const payroll = require("./payroll.service");
const ledger = require("./employeeLedger.service");
const { nextSeq } = require("../repositories/counter.repository");
const { parsePaging, pageResult } = require("../utils/pagination");
const { OPEN_FOR_SETTLEMENT, advanceOutstanding } = require("../utils/payroll");
const { badRequest, notFound, conflict } = require("../utils/errors");
const { presentAdvance, presentLedger, presentPeriod } = require("./payroll.present");
const { runAtomic } = require("../utils/unitOfWork");
const { postEntry, isKeyDup, asConflict, actorOf, fingerprint, assertSameRequest } = ledger;

/**
 * سلف الموظفين. دورة الحياة: pending (مسجَّلة لم تُصرف) → disbursed → partially_settled → settled،
 * أو cancelled (قبل الصرف) / reversed (بعد الصرف دون أي تسوية).
 *  - فترة الخصم تُختار صراحةً عند الإنشاء (إلزامي) ولا تُنقل تلقائياً أبداً؛ النقل بإجراء reassign صريح قبل أي تسوية.
 *  - الصرف خطوة منفصلة: method=cash ينشئ حركة نقد حقيقية (صادر) بعملة السلفة، وmethod=other لا ينشئ شيئاً في الصندوق.
 *  - التسوية تُطبَّق فقط على فترة الخصم المسنَدة، بنفس الموظف والعملة، ولا تتجاوز المتبقي من السلفة ولا من الراتب.
 */
const SETTLEABLE = ["disbursed", "partially_settled"];
const STATE_AR = { pending: "غير مصروفة", disbursed: "مصروفة", partially_settled: "مسوّاة جزئياً", settled: "مسوّاة بالكامل", cancelled: "ملغاة", reversed: "معكوسة" };

async function load(id, ctx) {
  const a = await advanceRepo.findById(id, ctx);
  if (!a) throw notFound("السلفة غير موجودة.", "ADVANCE_NOT_FOUND");
  return a;
}
const keysOf = async (a) => {
  const p = await payrollRepo.findById(a.deductionPeriod);
  return p ? { [String(p._id)]: p.periodKey } : {};
};
const out = async (a, extra = {}) => ({ advance: presentAdvance(a, await keysOf(a)), ...extra });

// فترة الخصم صالحة: نفس الموظف ونفس العملة ولم تُغلق ولم تُسدَّد بالكامل
function assertTargetPeriod(period, employeeId, currency) {
  if (!period) throw notFound("فترة الخصم غير موجودة.", "PERIOD_NOT_FOUND");
  if (String(period.employee) !== String(employeeId)) throw badRequest("فترة الخصم تخص موظفاً آخر.", "PERIOD_EMPLOYEE_MISMATCH");
  if (period.currency !== currency) throw badRequest("عملة السلفة لا تطابق عملة فترة الخصم.", "CURRENCY_MISMATCH");
  if (!OPEN_FOR_SETTLEMENT.includes(period.status)) throw conflict(`لا تُسنَد سلفة إلى فترة ${payroll.STATE_AR[period.status]}.`, "PERIOD_NOT_OPEN", { status: period.status });
}

async function create(body, actor, opts = {}) {
  const e = await employeeRepo.findById(body.employeeId);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  if (e.status !== "active") throw conflict("لا تُسجَّل سلفة لموظف غير فعّال.", "EMPLOYEE_INACTIVE");
  if (body.currency && body.currency !== e.currency) throw badRequest("عملة السلفة يجب أن تطابق عملة الموظف.", "CURRENCY_MISMATCH");
  const amountMinor = payroll.amountOf(e.currency, body.amount);
  // بصمة الطلب: المفتاح نفسه بمعطيات مختلفة = 409 (لا يُعاد أثر عملية سابقة كأنها نجحت)
  const hash = opts.requestHash || fingerprint({ op: "advance.create", employee: String(e._id), amountMinor, currency: e.currency, period: String(body.deductionPeriodId) });
  const prior = await advanceRepo.findByKey(body.idempotencyKey);
  if (prior) { assertSameRequest(prior, hash); return { duplicate: true, ...(await out(prior)) }; }
  const period = await payrollRepo.findById(body.deductionPeriodId);
  assertTargetPeriod(period, e._id, e.currency);
  try {
    const a = await runAtomic(async (ctx) => {
      const doc = await advanceRepo.create(
        {
          ref: `ADV-${String(await nextSeq("employeeAdvance", ctx)).padStart(6, "0")}`, employee: e._id, currency: e.currency, amountMinor, deductionPeriod: period._id,
          requestedDate: body.date ? new Date(body.date) : new Date(), note: body.note || "", idempotencyKey: body.idempotencyKey, requestHash: hash, createdBy: actorOf(actor),
        },
        ctx
      );
      ctx.undo(() => advanceRepo.deleteById(doc._id));
      return doc;
    });
    return { duplicate: false, ...(await out(a)) };
  } catch (err) {
    if (err.code === 11000) { const again = await advanceRepo.findByKey(body.idempotencyKey); if (again) { assertSameRequest(again, hash); return { duplicate: true, ...(await out(again)) }; } }
    throw err;
  }
}

async function get(id) {
  const a = await load(id);
  const entries = await ledgerRepo.byAdvance(a._id);
  const keys = await keysOf(a);
  return { advance: presentAdvance(a, keys), ledger: entries.map((l) => presentLedger(l, keys)) };
}

async function list(q) {
  const filter = {};
  if (q.employeeId) filter.employee = q.employeeId;
  if (q.status) filter.status = q.status;
  if (q.periodId) filter.deductionPeriod = q.periodId;
  const paging = parsePaging(q, 20);
  const { items, total } = await advanceRepo.list(filter, paging);
  const periods = await Promise.all([...new Set(items.map((a) => String(a.deductionPeriod)))].map((id) => payrollRepo.findById(id)));
  const keys = Object.fromEntries(periods.filter(Boolean).map((p) => [String(p._id), p.periodKey]));
  return pageResult(items.map((a) => presentAdvance(a, keys)), total, paging);
}

/** صرف السلفة: خطوة صريحة. حالة pending → disbursed بتحديث مشروط واحد، فلا يُصرف مرتين مهما تكرر الطلب أو تزامن */
async function disburse(id, body, actor) {
  const a = await load(id);
  if (a.status !== "pending") {
    if (["disbursed", "partially_settled", "settled"].includes(a.status)) return { duplicate: true, ...(await out(a)) };
    throw conflict(`لا تُصرف سلفة ${STATE_AR[a.status]}.`, "INVALID_STATE", { status: a.status });
  }
  const period = await payrollRepo.findById(a.deductionPeriod);
  assertTargetPeriod(period, a.employee, a.currency);
  const method = body.method || "cash";
  const at = body.date ? new Date(body.date) : new Date();
  try {
    const done = await runAtomic(async (ctx) => {
      const entry = await postEntry({ employee: a.employee, period: a.deductionPeriod, advance: a._id, type: "advance_disbursement", currency: a.currency, amountMinor: a.amountMinor, date: at, note: body.note || `صرف سلفة ${a.ref}`, key: `advdisb:${a._id}`, actor }, ctx);
      let cashId;
      if (method === "cash") {
        const { movement } = await cash.post({ currency: a.currency, direction: "out", amountMinor: a.amountMinor, type: "employee_advance", source: { kind: "employee_advance", id: a._id, ref: a.ref }, date: at, note: `سلفة موظف ${a.ref}`, key: `advcash:${a._id}`, actor }, ctx);
        cashId = movement._id;
        await ledgerRepo.setCash(entry._id, cashId, ctx);
      }
      const updated = await advanceRepo.disburse(a._id, { at, method, cash: cashId, by: actorOf(actor) }, ctx);
      if (!updated) throw conflict("صُرفت هذه السلفة مسبقاً.", "INVALID_STATE");
      return updated;
    });
    return { duplicate: false, ...(await out(done)) };
  } catch (err) {
    if (isKeyDup(err)) return { duplicate: true, ...(await out(await load(id))) };
    throw err;
  }
}

/** تسوية (خصم) من الراتب: فقط على فترة الخصم المسنَدة. لا تتجاوز المتبقي من السلفة ولا المتبقي من صافي الفترة */
async function settle(id, body, actor) {
  const a = await load(id);
  const key = `advsettle:${body.idempotencyKey}`;
  const hash = fingerprint({ op: "advance.settle", advance: String(a._id), amountMinor: payroll.amountOf(a.currency, body.amount) });
  const prior = await ledgerRepo.findByKey(key);
  if (prior) { assertSameRequest(prior, hash); return { duplicate: true, entry: presentLedger(prior), ...(await out(a)) }; }
  if (!SETTLEABLE.includes(a.status)) throw conflict(`لا تُسوّى سلفة ${STATE_AR[a.status]}${a.status === "pending" ? ": اصرفها أولاً" : ""}.`, "INVALID_STATE", { status: a.status });
  if (body.currency && body.currency !== a.currency) throw badRequest("عملة التسوية لا تطابق عملة السلفة.", "CURRENCY_MISMATCH");
  const p = await payrollRepo.findById(a.deductionPeriod);
  if (!p) throw notFound("فترة الخصم غير موجودة.", "PERIOD_NOT_FOUND");
  if (String(p.employee) !== String(a.employee)) throw badRequest("فترة الخصم تخص موظفاً آخر.", "PERIOD_EMPLOYEE_MISMATCH");
  if (p.currency !== a.currency) throw badRequest("عملة فترة الخصم لا تطابق عملة السلفة.", "CURRENCY_MISMATCH");
  const amountMinor = payroll.amountOf(a.currency, body.amount);
  if (amountMinor > advanceOutstanding(a)) throw conflict("مبلغ التسوية يتجاوز المتبقي من السلفة.", "OVER_SETTLEMENT", { outstandingMinor: advanceOutstanding(a) });
  const delta = { settledMinor: amountMinor };
  try {
    const res = await runAtomic(async (ctx) => {
      const e = await postEntry({ employee: a.employee, period: p._id, advance: a._id, type: "advance_settlement", currency: a.currency, amountMinor, date: body.date, note: body.note || `تسوية سلفة ${a.ref} من راتب ${p.periodKey}`, key, actor, requestHash: hash }, ctx);
      const adv = await advanceRepo.settle(a._id, amountMinor, ctx);
      if (!adv) throw conflict("مبلغ التسوية يتجاوز المتبقي من السلفة أو تغيّرت حالتها.", "OVER_SETTLEMENT");
      ctx.undo(() => advanceRepo.undoSettle(a._id, amountMinor));
      const per = await payrollRepo.adjust(p._id, delta, OPEN_FOR_SETTLEMENT, ctx);
      if (!per) throw payroll.explain(await payroll.loadPeriod(p._id, ctx), OPEN_FOR_SETTLEMENT, amountMinor, "تسوية سلفة");
      ctx.undo(() => payrollRepo.undoAdjust(p._id, delta));
      return { e, adv, per };
    });
    return { duplicate: false, entry: presentLedger(res.e), period: presentPeriod(res.per), ...(await out(res.adv)) };
  } catch (err) {
    if (isKeyDup(err)) { const again = await ledgerRepo.findByKey(key); assertSameRequest(again, hash); return { duplicate: true, entry: presentLedger(again), ...(await out(await load(id))) }; }
    throw err;
  }
}

async function reverseSettlement(id, entryId, body, actor) {
  const e = await ledgerRepo.findById(entryId);
  if (!e || String(e.advance) !== String(id)) throw notFound("قيد التسوية غير موجود لهذه السلفة.", "ENTRY_NOT_FOUND");
  const r = await payroll.reverseEntry(entryId, { reason: body.reason, expect: ["advance_settlement"], actor });
  return { ...r, ...(await out(await load(id))) };
}

/** إلغاء سلفة لم تُصرف، أو عكس سلفة مصروفة لم تُسوَّ منها أي قطعة (يعكس حركة النقد الحقيقية إن وُجدت) */
async function reverse(id, body, actor) {
  const a = await load(id);
  if (["cancelled", "reversed"].includes(a.status)) throw conflict("هذه السلفة ملغاة/معكوسة مسبقاً.", "ALREADY_REVERSED");
  if (a.settledMinor > 0) throw conflict("سُوِّيت أجزاء من هذه السلفة: اعكس التسويات أولاً.", "HAS_SETTLEMENTS");
  const from = a.status;
  const to = from === "pending" ? "cancelled" : "reversed";
  const reversal = { at: new Date(), reason: body.reason, by: actorOf(actor) };
  try {
    const done = await runAtomic(async (ctx) => {
      const upd = await advanceRepo.finish(a._id, from, to, reversal, ctx);
      if (!upd) throw conflict("تغيّرت حالة السلفة: أعد المحاولة.", "INVALID_STATE");
      ctx.undo(() => advanceRepo.undoFinish(a._id, from));
      if (from !== "pending") {
        const orig = (await ledgerRepo.byAdvance(a._id)).find((l) => l.type === "advance_disbursement" && !l.reversedBy);
        if (orig) {
          const r = await postEntry({ employee: a.employee, period: orig.period, advance: a._id, type: "reversal", reverseOf: "advance_disbursement", reverses: orig._id, currency: a.currency, amountMinor: a.amountMinor, note: `عكس ${a.ref}: ${body.reason}`, key: `entrev:${orig._id}`, actor }, ctx);
          const marked = await ledgerRepo.markReversed(orig._id, r._id, ctx);
          if (!marked) throw conflict("هذه السلفة معكوسة مسبقاً.", "ALREADY_REVERSED");
          ctx.undo(() => ledgerRepo.unmarkReversed(orig._id));
        }
        if (a.disbursement?.cash) await cash.reverseSource("employee_advance", a._id, { type: "payroll_reversal", note: `عكس ${a.ref}: ${body.reason}`, actor, keyPrefix: "advrev" }, ctx);
      }
      return upd;
    });
    return out(done);
  } catch (err) {
    return asConflict(err, "هذه السلفة معكوسة مسبقاً.", "ALREADY_REVERSED");
  }
}

/** إعادة إسناد فترة الخصم: إجراء صريح مصرَّح، قبل أي تسوية وإلى فترة مفتوحة للموظف نفسه وبالعملة نفسها. يُسجَّل في الدفتر */
async function reassign(id, body, actor) {
  const a = await load(id);
  const rhash = fingerprint({ op: "advance.reassign", advance: String(a._id), period: String(body.periodId) });
  const rprior = await ledgerRepo.findByKey(`advreassign:${body.idempotencyKey}`);
  if (rprior) { assertSameRequest(rprior, rhash); return { duplicate: true, ...(await out(a)) }; }
  if (!["pending", "disbursed"].includes(a.status) || a.settledMinor > 0) throw conflict("لا تُنقل سلفة سُوِّيت أو أُغلقت.", "INVALID_STATE", { status: a.status });
  if (String(a.deductionPeriod) === body.periodId) throw badRequest("السلفة مسنَدة لهذه الفترة أصلاً.", "SAME_PERIOD");
  const target = await payrollRepo.findById(body.periodId);
  assertTargetPeriod(target, a.employee, a.currency);
  const from = a.deductionPeriod;
  try {
    const done = await runAtomic(async (ctx) => {
      await postEntry({ employee: a.employee, period: target._id, advance: a._id, type: "adjustment", currency: a.currency, amountMinor: a.amountMinor, note: `إعادة إسناد ${a.ref} من فترة سابقة إلى ${target.periodKey}: ${body.reason}`, key: `advreassign:${body.idempotencyKey}`, actor, requestHash: rhash }, ctx);
      const upd = await advanceRepo.reassign(a._id, from, target._id, ctx);
      if (!upd) throw conflict("تغيّرت حالة السلفة: أعد المحاولة.", "INVALID_STATE");
      ctx.undo(() => advanceRepo.reassign(a._id, target._id, from));
      return upd;
    });
    return { duplicate: false, ...(await out(done)) };
  } catch (err) {
    if (isKeyDup(err)) return { duplicate: true, ...(await out(await load(id))) };
    throw err;
  }
}

module.exports = { create, get, list, disburse, settle, reverseSettlement, reverse, reassign };
