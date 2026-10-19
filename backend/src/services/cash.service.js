const cashRepo = require("../repositories/cash.repository");
const { nextSeq } = require("../repositories/counter.repository");
const { toMinorC, fromMinorC, validAmount } = require("../utils/money");
const { runAtomic } = require("../utils/unitOfWork");
const { parsePaging, pageResult } = require("../utils/pagination");
const { badRequest, notFound, conflict } = require("../utils/errors");
const { isSalaryCategory } = require("../utils/payroll");

/**
 * دفتر الصندوقين المستقلين (ليرة / دولار). القواعد:
 *  1) حركة النقد بعملة الدفع الفعلية وتؤثر على صندوق تلك العملة فقط. لا يوجد أي تحويل أو جمع بين الصندوقين.
 *  2) الفاتورة/الالتزام لا ينشئ حركة نقد: فقط الدفع/القبض/الرد الفعلي.
 *  3) كل ترحيل له مفتاح تكرار حتمي مشتق من مصدره (مثل sale:<id>) فلا تتكرر الحركة مهما أُعيد الطلب.
 *  4) التصحيح بحركة عكسية تُوسَم بها الأصلية مرة واحدة؛ لا تعديل ولا حذف.
 */
const actorOf = (a) => (a ? { id: a.id, name: a.name } : undefined);
const fmt = (n) => `CSH-${String(n).padStart(6, "0")}`;

const present = (m) => ({
  id: String(m._id), ref: m.ref, currency: m.currency, direction: m.direction, type: m.type,
  amount: fromMinorC(m.currency, m.amountMinor), date: m.date, note: m.note || "",
  source: { kind: m.source.kind, ref: m.source.ref || "" },
  reverses: m.reverses ? String(m.reverses) : null, reversed: !!m.reversedBy, createdBy: m.createdBy?.name || "", createdAt: m.createdAt,
});

/** ترحيل حركة نقد داخل وحدة ذرّية. يعيد { movement, duplicate } ولا ينشئ مرتين لنفس المفتاح */
async function post(spec, ctx) {
  const { currency, direction, amountMinor, type, source, supplier, date, note = "", key, reverses, actor } = spec;
  if (!["USD", "SYP"].includes(currency)) throw badRequest("عملة غير صالحة.", "INVALID_CURRENCY");
  if (!Number.isInteger(amountMinor) || amountMinor < 1) throw badRequest("مبلغ الحركة النقدية غير صالح.", "INVALID_AMOUNT");
  const prior = await cashRepo.findByKey(key, ctx);
  if (prior) return { movement: prior, duplicate: true };
  const movement = await cashRepo.create(
    {
      ref: fmt(await nextSeq("cashMovement", ctx)), currency, direction, amountMinor, type, source, supplier,
      date: date ? new Date(date) : new Date(), note, reverses, idempotencyKey: key, createdBy: actorOf(actor),
    },
    ctx
  );
  ctx.undo(() => cashRepo.deleteById(movement._id));
  return { movement, duplicate: false };
}

/** يعكس كل الحركات غير المعكوسة لمصدر معيّن (إلغاء فاتورة، عكس دفعة مورد، عكس مصروف) بحركات معاكسة بنفس العملة */
async function reverseSource(kind, id, { type, note, actor, keyPrefix }, ctx) {
  const originals = (await cashRepo.bySource(kind, id, ctx)).filter((m) => !m.reverses && !m.reversedBy);
  const out = [];
  for (const o of originals) {
    const { movement } = await post(
      {
        currency: o.currency, direction: o.direction === "in" ? "out" : "in", amountMinor: o.amountMinor, type, source: o.source, supplier: o.supplier,
        note, key: `${keyPrefix}:${o._id}`, reverses: o._id, actor,
      },
      ctx
    );
    const marked = await cashRepo.markReversed(o._id, movement._id, ctx);
    if (!marked) throw conflict("حركة النقد معكوسة مسبقاً.", "CASH_ALREADY_REVERSED");
    ctx.undo(() => cashRepo.unmarkReversed(o._id));
    out.push(movement);
  }
  return out;
}

// ---------------------------------------------------------------- ربط المعاملات بالنقد
/** بيع نقدي: يدخل صندوق عملة الفاتورة المبلغ المدفوع فعلاً (cashDue). سالب (تبديل بفائض) = رد نقدي من نفس الصندوق */
async function recordSale(invoice, actor, ctx) {
  const due = toMinorC(invoice.currency, invoice.cashDue ?? invoice.totalPaid);
  if (due === 0) return null;
  return post(
    {
      currency: invoice.currency, direction: due > 0 ? "in" : "out", amountMinor: Math.abs(due), type: due > 0 ? "sale_receipt" : "customer_refund",
      source: { kind: "invoice", id: invoice._id, ref: `INV-${invoice.number}` }, note: due > 0 ? `قبض فاتورة #${invoice.number}` : `رد فائض تبديل #${invoice.number}`,
      key: `sale:${invoice._id}`, actor,
    },
    ctx
  );
}

async function recordInvoiceCancel(invoice, actor, ctx) {
  return reverseSource("invoice", invoice._id, { type: "sale_cancellation", note: `إلغاء فاتورة #${invoice.number}`, actor, keyPrefix: "salecancel" }, ctx);
}

/** مرتجع نقدي: الرد بعملة الفاتورة الأصلية من صندوقها فقط */
async function recordCustomerRefund(ret, actor, ctx) {
  const amt = toMinorC(ret.currency, ret.cashRefund || 0);
  if (amt <= 0) return null;
  return post(
    {
      currency: ret.currency, direction: "out", amountMinor: amt, type: "customer_refund",
      source: { kind: "return", id: ret._id, ref: `RET-${ret.number}` }, note: `رد مرتجع #${ret.number} (فاتورة #${ret.invoiceNumber})`, key: `refund:${ret._id}`, actor,
    },
    ctx
  );
}

/** دفعة/سلفة لمورد: تخرج من صندوق عملة الدفع الفعلية بمبلغها الأصلي (لا يُستعمل أي معادل دولاري) */
async function recordSupplierPayment(entry, actor, ctx) {
  return post(
    {
      currency: entry.currency, direction: "out", amountMinor: entry.amountMinor, type: entry.type === "advance" ? "supplier_advance" : "supplier_payment",
      source: { kind: "supplier_entry", id: entry._id, ref: entry.ref }, supplier: entry.supplier, date: entry.date, note: entry.note || "", key: `supent:${entry._id}`, actor,
    },
    ctx
  );
}

async function reverseSupplierPayment(entry, actor, ctx) {
  return reverseSource("supplier_entry", entry._id, { type: "supplier_reversal", note: `عكس ${entry.ref}`, actor, keyPrefix: "supentrev" }, ctx);
}

// ---------------------------------------------------------------- المصروفات
/** يُنشئ مصروفاً داخل وحدة ذرّية قائمة. noCash: دفع من خارج الصندوق (لا حركة نقد). extra: حقول ربط (مصروف راتب) */
async function postExpense({ currency, amountMinor, category, description = "", date, idempotencyKey, noCash = false, extra = {}, actor }, ctx) {
  const e = await cashRepo.createExpense(
    { ref: `EXP-${String(await nextSeq("expense", ctx)).padStart(6, "0")}`, currency, amountMinor, category: category.trim(), description, date: date ? new Date(date) : new Date(), idempotencyKey, createdBy: actorOf(actor), ...extra },
    ctx
  );
  ctx.undo(() => cashRepo.deleteExpense(e._id));
  let movement = null;
  if (!noCash) {
    ({ movement } = await post({ currency, direction: "out", amountMinor, type: "expense", source: { kind: "expense", id: e._id, ref: e.ref }, date: e.date, note: `${e.category}${description ? ` · ${description}` : ""}`, key: `exp:${e._id}`, actor }, ctx));
    await cashRepo.setExpenseCash(e._id, movement._id, ctx);
  }
  return { expense: { ...e, cash: movement?._id }, movement };
}

/** عكس مصروف داخل وحدة ذرّية قائمة (يعكس حركته النقدية إن وُجدت) */
async function reverseExpenseInCtx(expenseId, reason, actor, ctx) {
  const e = await cashRepo.findExpense(expenseId, ctx);
  if (!e) throw notFound("المصروف غير موجود.", "EXPENSE_NOT_FOUND");
  const marked = await cashRepo.markExpenseReversed(e._id, { at: new Date(), reason, by: actorOf(actor) }, ctx);
  if (!marked) throw conflict("هذا المصروف معكوس مسبقاً.", "ALREADY_REVERSED");
  ctx.undo(() => cashRepo.unmarkExpenseReversed(e._id));
  await reverseSource("expense", e._id, { type: "expense_reversal", note: `عكس ${e.ref}: ${reason}`, actor, keyPrefix: "exprev" }, ctx);
  return e;
}

async function createExpense(body, actor) {
  // مصروف الرواتب: الحساب والتحقق وتحديث حساب الموظف كلها في خدمة الرواتب (مصدر وحيد)، وهنا يُنشأ المصروف نفسه ضمن العملية
  if (isSalaryCategory(body.category) || body.employeeId) return require("./employeeFinance.service").paySalaryExpense(body, actor);
  return createOrdinaryExpense(body, actor);
}

async function createOrdinaryExpense({ currency, amount, category, description = "", date, idempotencyKey }, actor) {
  if (!validAmount(currency, amount)) throw badRequest(currency === "SYP" ? "مبلغ الليرة عدد صحيح." : "مبلغ الدولار بخانتين عشريتين كحد أقصى.", "INVALID_AMOUNT_PRECISION");
  const prior = await cashRepo.findExpenseByKey(idempotencyKey);
  if (prior) return { duplicate: true, expense: presentExpense(prior) };
  const amountMinor = toMinorC(currency, amount);
  try {
    const exp = await runAtomic(async (ctx) => {
      const e = await cashRepo.createExpense(
        { ref: `EXP-${String(await nextSeq("expense", ctx)).padStart(6, "0")}`, currency, amountMinor, category: category.trim(), description, date: date ? new Date(date) : new Date(), idempotencyKey, createdBy: actorOf(actor) },
        ctx
      );
      ctx.undo(() => cashRepo.deleteExpense(e._id));
      const { movement } = await post({ currency, direction: "out", amountMinor, type: "expense", source: { kind: "expense", id: e._id, ref: e.ref }, date: e.date, note: `${e.category}${description ? ` · ${description}` : ""}`, key: `exp:${e._id}`, actor }, ctx);
      await cashRepo.setExpenseCash(e._id, movement._id, ctx);
      return { ...e, cash: movement._id };
    });
    return { duplicate: false, expense: presentExpense(exp) };
  } catch (err) {
    if (err.code === 11000) {
      const again = await cashRepo.findExpenseByKey(idempotencyKey);
      if (again) return { duplicate: true, expense: presentExpense(again) };
    }
    throw err;
  }
}

async function reverseExpense(id, { reason }, actor) {
  const e = await cashRepo.findExpense(id);
  if (!e) throw notFound("المصروف غير موجود.", "EXPENSE_NOT_FOUND");
  if (e.status !== "posted") throw conflict("هذا المصروف معكوس مسبقاً.", "ALREADY_REVERSED");
  // مصروف راتب: العكس يعيد أثر الدفعة على حساب الموظف أيضاً (خدمة الرواتب)
  if (e.employee) return require("./employeeFinance.service").reverseSalaryExpense(e, { reason }, actor);
  await runAtomic(async (ctx) => {
    const marked = await cashRepo.markExpenseReversed(e._id, { at: new Date(), reason, by: actorOf(actor) }, ctx);
    if (!marked) throw conflict("هذا المصروف معكوس مسبقاً.", "ALREADY_REVERSED");
    ctx.undo(() => cashRepo.unmarkExpenseReversed(e._id));
    await reverseSource("expense", e._id, { type: "expense_reversal", note: `عكس ${e.ref}: ${reason}`, actor, keyPrefix: "exprev" }, ctx);
  });
  return { expense: presentExpense(await cashRepo.findExpense(e._id)) };
}

const presentExpense = (e) => ({
  id: String(e._id), ref: e.ref, currency: e.currency, amount: fromMinorC(e.currency, e.amountMinor), category: e.category, description: e.description || "",
  employeeId: e.employee ? String(e.employee) : null, periodKey: e.periodKey || null, method: e.method || "cash",
  date: e.date, status: e.status, reversal: e.reversal ? { at: e.reversal.at, reason: e.reversal.reason, by: e.reversal.by?.name || "" } : null, createdBy: e.createdBy?.name || "",
});

async function listExpenses(q) {
  const filter = {};
  if (q.currency) filter.currency = q.currency;
  if (q.from && q.to) filter.date = { $gte: new Date(q.from), $lt: new Date(q.to) };
  const paging = parsePaging(q, 25);
  const { items, total } = await cashRepo.listExpenses(filter, paging);
  return pageResult(items.map(presentExpense), total, paging);
}

// ---------------------------------------------------------------- حركات يدوية (إيداع/سحب/رصيد افتتاحي) وعكسها
async function manual({ currency, direction, amount, note, date, idempotencyKey }, actor) {
  if (!validAmount(currency, amount)) throw badRequest(currency === "SYP" ? "مبلغ الليرة عدد صحيح." : "مبلغ الدولار بخانتين عشريتين كحد أقصى.", "INVALID_AMOUNT_PRECISION");
  try {
    const out = await runAtomic((ctx) =>
      post({ currency, direction, amountMinor: toMinorC(currency, amount), type: direction === "in" ? "deposit" : "withdrawal", source: { kind: "manual", ref: "MANUAL" }, note, date, key: `manual:${idempotencyKey}`, actor }, ctx)
    );
    return { duplicate: out.duplicate, movement: present(out.movement) };
  } catch (err) {
    if (err.code === 11000) {
      const again = await cashRepo.findByKey(`manual:${idempotencyKey}`);
      if (again) return { duplicate: true, movement: present(again) };
    }
    throw err;
  }
}

async function reverseManual(id, { reason }, actor) {
  const m = await cashRepo.findById(id);
  if (!m) throw notFound("حركة النقد غير موجودة.", "CASH_NOT_FOUND");
  if (m.source.kind !== "manual") throw conflict("تُعكس هذه الحركة من معاملتها الأصلية (فاتورة/مرتجع/دفعة مورد/مصروف) لا من هنا.", "CASH_REVERSE_VIA_SOURCE");
  if (m.reverses || m.reversedBy) throw conflict("هذه الحركة معكوسة مسبقاً أو هي حركة عكسية.", "CASH_ALREADY_REVERSED");
  try {
    const out = await runAtomic(async (ctx) => {
      const { movement } = await post({ currency: m.currency, direction: m.direction === "in" ? "out" : "in", amountMinor: m.amountMinor, type: "reversal", source: m.source, note: `عكس ${m.ref}: ${reason}`, key: `manualrev:${m._id}`, reverses: m._id, actor }, ctx);
      const marked = await cashRepo.markReversed(m._id, movement._id, ctx);
      if (!marked) throw conflict("هذه الحركة معكوسة مسبقاً.", "CASH_ALREADY_REVERSED");
      ctx.undo(() => cashRepo.unmarkReversed(m._id));
      return movement;
    });
    return { movement: present(out) };
  } catch (err) {
    if (err.code === 11000) throw conflict("هذه الحركة معكوسة مسبقاً.", "CASH_ALREADY_REVERSED");
    throw err;
  }
}

async function listMovements(q) {
  const filter = {};
  if (q.currency) filter.currency = q.currency;
  if (q.type) filter.type = q.type;
  if (q.from && q.to) filter.date = { $gte: new Date(q.from), $lt: new Date(q.to) };
  const paging = parsePaging(q, 25);
  const { items, total } = await cashRepo.list(filter, paging);
  return pageResult(items.map(present), total, paging);
}

module.exports = {
  post, postExpense, reverseExpenseInCtx, getExpense: async (id) => { const e = await cashRepo.findExpense(id); return e ? presentExpense(e) : null; }, reverseSource, recordSale, recordInvoiceCancel, recordCustomerRefund, recordSupplierPayment, reverseSupplierPayment,
  createExpense, reverseExpense, listExpenses, manual, reverseManual, listMovements, present, presentExpense, actorOf,
};
