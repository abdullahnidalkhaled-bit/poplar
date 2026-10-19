const entryRepo = require("../repositories/supplierEntry.repository");
const invoiceRepo = require("../repositories/supplierInvoice.repository");
const allocRepo = require("../repositories/supplierAllocation.repository");
const returnRepo = require("../repositories/supplierReturn.repository");
const settlementRepo = require("../repositories/supplierSettlement.repository");
const seriesRepo = require("../repositories/series.repository");
const { nextSeq } = require("../repositories/counter.repository");
const supplierService = require("./supplier.service");
const supplierRepo = require("../repositories/supplier.repository");
const cashService = require("./cash.service");
const acct = require("../utils/supplierAccount");
const { toMinorC, fromMinorC, validAmount } = require("../utils/money");
const { runAtomic } = require("../utils/unitOfWork");
const { parsePaging, pageResult } = require("../utils/pagination");
const { badRequest, notFound, conflict } = require("../utils/errors");

const fmt = (prefix, n) => `${prefix}-${String(n).padStart(6, "0")}`;
const invoiceKeyOf = (no) => String(no).trim().replace(/\s+/g, " ").toUpperCase();
const actorOf = (a) => (a ? { id: a.id, name: a.name } : undefined);
const M = (cur, minor) => fromMinorC(cur, minor);

// ---------------------------------------------------------------- المبالغ (سياسة العملات)
// القيد بعملته الأصلية: المبلغ الأصلي + وحدته الصغرى الصحيحة. سعر الصرف اختياري ويُحفظ كما أُدخل للتوثيق فقط
// (لا يُجلب من الإعدادات ولا يُخترع). لا يوجد معادل دولاري يدخل في أي رصيد أو نقد.
function toMoney({ amount, currency = "USD", rate }) {
  if (!validAmount(currency, amount)) throw badRequest(currency === "SYP" ? "مبلغ الليرة السورية عدد صحيح." : "مبلغ الدولار بخانتين عشريتين كحد أقصى.", "INVALID_AMOUNT_PRECISION");
  const amountMinor = toMinorC(currency, amount);
  if (!(amountMinor > 0)) throw badRequest("المبلغ غير صالح.", "AMOUNT_TOO_SMALL");
  const out = { currency, amount, amountMinor, rate: rate || 0 };
  if (currency === "USD") out.valuationUsdMinor = amountMinor;
  else if (rate > 0) out.valuationUsdMinor = Math.round((amount * 100) / rate); // توثيق تاريخي فقط
  return out;
}

// ---------------------------------------------------------------- قيد في الدفتر (داخل وحدة ذرّية)
async function postEntry(spec, ctx) {
  const signed = spec.signedMinor ?? acct.signedMinor(spec.type, spec.amountMinor);
  const entry = await entryRepo.create(
    {
      ...spec,
      ref: fmt("SUP", await nextSeq("supplierEntry", ctx)),
      date: spec.date ? new Date(spec.date) : new Date(),
      signedMinor: signed,
      amount: M(spec.currency, spec.amountMinor),
    },
    ctx
  );
  ctx.undo(() => entryRepo.deleteById(entry._id));
  return entry;
}

// تخصيص (للإلحاق فقط) رصيد دائن على فاتورة، ثم تحقق حدودي داخل نفس الوحدة: لا فرط تخصيص حتى مع طلبات متزامنة
async function postAllocation({ supplier, entry, invoice, amountMinor, creditMinor, crossCurrency = false, rate = 0, source, note = "", idempotencyKey, actor }, ctx) {
  const cm = creditMinor ?? amountMinor;
  await supplierRepo.touchLock(supplier, ctx); // يسلسل التخصيصات المتزامنة لنفس التاجر قبل فحص الحدود
  const a = await allocRepo.create(
    {
      ref: fmt("ALC", await nextSeq("supplierAllocation", ctx)), supplier, kind: "apply", entry: entry._id, invoice: invoice._id,
      currency: invoice.currency, amountMinor, creditCurrency: entry.currency, creditMinor: cm, crossCurrency, rate, source, note, idempotencyKey, createdBy: actorOf(actor),
    },
    ctx
  );
  ctx.undo(() => allocRepo.deleteById(a._id));
  const onEntry = acct.allocationTotals(await allocRepo.forEntry(entry._id, ctx), [invoice], [entry]).byEntry.get(String(entry._id)) || 0;
  if (onEntry > acct.amountMinorOf(entry)) throw conflict("المبلغ يتجاوز الرصيد الدائن المتاح في هذا القيد.", "ALLOCATION_EXCEEDS_CREDIT");
  const onInvoice = acct.allocationTotals(await allocRepo.forInvoice(invoice._id, ctx), [invoice], [entry]).byInvoice.get(String(invoice._id)) || 0;
  if (onInvoice > acct.invoiceMinorOf(invoice)) throw conflict("المبلغ يتجاوز المتبقي على هذه الفاتورة. سجّل الزيادة كسلفة.", "INVOICE_OVERPAID");
  return a;
}

// مفتاح الطلب: نفس المفتاح مرة ثانية يعيد القيد الأول ولا يُرحَّل شيء جديد
async function priorByKey(key, supplierId, types) {
  const prior = await entryRepo.findByKey(key);
  if (!prior) return null;
  if (String(prior.supplier) !== String(supplierId) || (types && !types.includes(prior.type))) throw conflict("مفتاح الطلب مستخدم لعملية أخرى.", "IDEMPOTENCY_MISMATCH");
  return prior;
}

// ---------------------------------------------------------------- عرض (كل رقم مع عملته)
const presentEntry = (e, ctx = {}) => {
  const signed = acct.signedMinorOf(e);
  const origType = e.type === "reversal" ? ctx.typeOf?.get(String(e.reverses)) : e.type;
  return {
    id: String(e._id),
    ref: e.ref,
    type: e.type,
    date: e.date,
    note: e.note || "",
    currency: e.currency,
    amount: M(e.currency, acct.amountMinorOf(e)),
    rate: e.rate || 0,
    valuationUsd: e.valuationUsdMinor != null && e.currency !== "USD" ? e.valuationUsdMinor / 100 : null, // توثيق تاريخي فقط
    debit: signed > 0 ? M(e.currency, signed) : 0,
    credit: signed < 0 ? M(e.currency, -signed) : 0,
    balance: e.balance ?? null,
    movesCash: !!origType && acct.CASH_OUT_TYPES.has(origType),
    crossCurrency: e.crossCurrency?.invoiceCurrency ? { invoiceCurrency: e.crossCurrency.invoiceCurrency, settles: M(e.crossCurrency.invoiceCurrency, e.crossCurrency.settlesMinor), rate: e.crossCurrency.rate } : null,
    invoice: e.invoice ? { id: String(e.invoice), invoiceNo: ctx.invoices?.get(String(e.invoice))?.invoiceNo || "" } : null,
    supplierReturn: e.supplierReturn ? { id: String(e.supplierReturn), ref: ctx.returns?.get(String(e.supplierReturn))?.ref || "" } : null,
    settlement: ctx.settlementOf?.get(String(e._id)) || null,
    reverses: e.reverses ? { id: String(e.reverses), ref: ctx.refs?.get(String(e.reverses)) || "" } : null,
    reversedBy: e.reversedBy ? { id: String(e.reversedBy), ref: ctx.refs?.get(String(e.reversedBy)) || "" } : null,
    createdBy: e.createdBy?.name || "",
    createdAt: e.createdAt,
  };
};

const presentInvoice = (inv, state) => {
  const total = acct.invoiceMinorOf(inv);
  return {
    id: String(inv._id),
    invoiceNo: inv.invoiceNo,
    kind: inv.kind,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate || null,
    currency: inv.currency,
    amount: M(inv.currency, total),
    rate: inv.rate || 0,
    terms: inv.terms || "",
    note: inv.note || "",
    seriesNos: inv.seriesNos || [],
    shipmentRefs: inv.shipmentRefs || [],
    status: inv.status,
    overdue: inv.status === "posted" && !!inv.dueDate && new Date(inv.dueDate) < new Date() && (state ? state.outstandingMinor : total) > 0,
    allocated: M(inv.currency, state?.allocatedMinor || 0),
    outstanding: M(inv.currency, state ? state.outstandingMinor : total),
    payStatus: state?.payStatus || "unpaid",
    createdAt: inv.createdAt,
  };
};

const presentAllocation = (a, ctx) => ({
  id: String(a._id), ref: a.ref, kind: a.kind, source: a.source, note: a.note || "",
  currency: a.currency, amount: M(a.currency, a.amountMinor),
  creditCurrency: a.creditCurrency || a.currency, creditAmount: M(a.creditCurrency || a.currency, a.creditMinor ?? a.amountMinor),
  crossCurrency: !!a.crossCurrency, rate: a.rate || 0, needsReview: !!a.needsReview,
  entry: { id: String(a.entry), ref: ctx.refs.get(String(a.entry)) || "" },
  invoice: { id: String(a.invoice), invoiceNo: ctx.invoices.get(String(a.invoice))?.invoiceNo || "" },
  releases: a.releases ? String(a.releases) : null, released: !!a.releasedBy, createdBy: a.createdBy?.name || "", createdAt: a.createdAt,
});

// ---------------------------------------------------------------- فواتير التاجر
async function validateLinks(supplierId, kind, seriesNos) {
  if (!seriesNos?.length) return [];
  const nos = [...new Set(seriesNos.map((n) => n.toUpperCase()))];
  const found = await seriesRepo.findBySeriesNos(nos);
  const missing = nos.filter((n) => !found.some((s) => s.seriesNo === n));
  if (missing.length) throw notFound(`أرتال غير موجودة: ${missing.join("، ")}`, "SERIES_NOT_FOUND");
  for (const s of found) {
    if (s.supplier && String(s.supplier) !== String(supplierId)) throw conflict(`الرتل ${s.seriesNo} يخص تاجراً آخر.`, "SERIES_SUPPLIER_MISMATCH");
    if (s.ownership === "consignment" && kind !== "consignment_settlement") {
      throw conflict(`الرتل ${s.seriesNo} بضاعة أمانة: لا يُربط بفاتورة شراء. استعمل «تسوية بضاعة أمانة مباعة».`, "CONSIGNMENT_NOT_PURCHASE");
    }
  }
  return nos;
}

// فاتورة تاجر (التزام مالي بعملتها، بلا أي أثر على النقد). التسوية من مسارها المرتبط بالكميات المباعة فقط
async function createInvoice(supplierId, body, actor) {
  if (body.kind === "consignment_settlement") throw badRequest("تسوية الأمانة تُسجَّل من «تسوية البضاعة المباعة» لربطها بالكميات المباعة والأسعار المتفق عليها.", "USE_SETTLEMENT_WORKFLOW");
  const supplier = await supplierService.requireSupplier(supplierId);
  if (!supplier.active) throw conflict("التاجر معطّل: فعّله قبل تسجيل فواتير جديدة.", "SUPPLIER_INACTIVE");
  const invoiceKey = invoiceKeyOf(body.invoiceNo);

  const existing = await invoiceRepo.findByKey(supplier._id, invoiceKey);
  if (existing) {
    const entry = existing.entry ? await entryRepo.findById(existing.entry) : null;
    if (entry?.idempotencyKey === body.idempotencyKey) return { duplicate: true, invoice: presentInvoice(existing), entry: presentEntry(entry) };
    throw conflict(`فاتورة التاجر رقم ${body.invoiceNo} مسجّلة مسبقاً لهذا التاجر.`, "DUPLICATE_INVOICE");
  }
  const prior = await priorByKey(body.idempotencyKey, supplier._id, ["purchase"]);
  if (prior) return { duplicate: true, entry: presentEntry(prior) };

  if (body.dueDate && new Date(body.dueDate) < new Date(body.invoiceDate)) throw badRequest("تاريخ الاستحقاق قبل تاريخ الفاتورة.", "INVALID_DATES");
  const seriesNos = await validateLinks(supplier._id, "purchase", body.seriesNos);
  const m = toMoney(body);
  const out = await postInvoiceTx(supplier, { ...body, invoiceKey, seriesNos, m, kind: "purchase" }, actor);
  return { duplicate: false, invoice: presentInvoice(out.invoice, { allocatedMinor: 0, outstandingMinor: m.amountMinor, payStatus: "unpaid" }), entry: presentEntry(out.entry) };
}

async function postInvoiceTx(supplier, { invoiceNo, invoiceKey, kind, invoiceDate, dueDate, terms, note, seriesNos, shipmentRefs, m, idempotencyKey, entryNote }, actor, outerCtx) {
  const work = async (ctx) => {
    const invoice = await invoiceRepo.create(
      {
        supplier: supplier._id, invoiceNo: invoiceNo.trim(), invoiceKey, kind, invoiceDate: new Date(invoiceDate),
        dueDate: dueDate ? new Date(dueDate) : undefined, currency: m.currency, amount: m.amount, amountMinor: m.amountMinor, rate: m.rate, valuationUsdMinor: m.valuationUsdMinor,
        terms: terms || "", note: note || "", seriesNos: seriesNos || [], shipmentRefs: shipmentRefs || [], createdBy: actorOf(actor),
      },
      ctx
    );
    ctx.undo(() => invoiceRepo.deleteById(invoice._id));
    const entry = await postEntry(
      { supplier: supplier._id, type: "purchase", ...m, date: invoiceDate, invoice: invoice._id, idempotencyKey, note: entryNote || `فاتورة التاجر ${invoiceNo.trim()}${note ? ` · ${note}` : ""}`, createdBy: actorOf(actor) },
      ctx
    );
    await invoiceRepo.setEntry(invoice._id, entry._id, ctx);
    return { invoice: { ...invoice, entry: entry._id }, entry };
  };
  try {
    return outerCtx ? await work(outerCtx) : await runAtomic(work);
  } catch (err) {
    if (err.code === 11000) throw conflict("هذه الفاتورة أو مفتاح الطلب مسجّل مسبقاً.", "DUPLICATE_INVOICE");
    throw err;
  }
}

// ---------------------------------------------------------------- فاتورة شراء مع الاستلام (داخل وحدة الاستلام الذرّية نفسها)
// ينشئ: فاتورة التاجر (التزام بلا نقد) + اختيارياً دفعة نقدية فعلية (حركة نقد واحدة من صندوق عملة الفاتورة) تُخصَّص مباشرة عليها
// + اختيارياً تخصيص سلف قائمة (لا حركة نقد ثانية). كل شيء يُلغى معاً إن فشل أي جزء. العملة واحدة: السلف بعملة الفاتورة فقط هنا.
async function postReceiptPurchase(supplier, p, { shipmentRef, seriesNos, key, actor }, ctx) {
  const m = toMoney({ amount: p.amount, currency: p.currency, rate: p.rate });
  const invoiceDate = p.invoiceDate || new Date().toISOString();
  if (p.dueDate && new Date(p.dueDate) < new Date(invoiceDate)) throw badRequest("تاريخ الاستحقاق قبل تاريخ الفاتورة.", "INVALID_DATES");
  const { invoice, entry } = await postInvoiceTx(
    supplier,
    { invoiceNo: p.invoiceNo, invoiceKey: invoiceKeyOf(p.invoiceNo), kind: "purchase", invoiceDate, dueDate: p.dueDate, terms: p.terms, note: `استلام ${shipmentRef}`, seriesNos, shipmentRefs: [shipmentRef], m, idempotencyKey: `${key}:inv`, entryNote: `فاتورة التاجر ${p.invoiceNo.trim()} · استلام ${shipmentRef}` },
    actor,
    ctx
  );
  const out = { invoice, entry, cashEntry: null, allocations: [], paidMinor: 0, advanceMinor: 0 };
  const pay = p.payment || {};
  const payDate = pay.date || invoiceDate;

  if (pay.cashAmount) {
    const pm = toMoney({ amount: pay.cashAmount, currency: p.currency });
    const e = await postEntry({ supplier: supplier._id, type: "payment", ...pm, date: payDate, invoice: invoice._id, idempotencyKey: `${key}:pay`, note: `دفعة عند الاستلام · فاتورة ${p.invoiceNo.trim()}`, createdBy: actorOf(actor) }, ctx);
    await cashService.recordSupplierPayment(e, actor, ctx); // حركة نقد واحدة فعلية
    out.allocations.push(await postAllocation({ supplier: supplier._id, entry: e, invoice, amountMinor: pm.amountMinor, source: "direct", actor }, ctx));
    out.cashEntry = e;
    out.paidMinor = pm.amountMinor;
  }
  let i = 0;
  for (const adv of pay.advances || []) {
    const e = await entryRepo.findById(adv.entryId, ctx);
    if (!e || String(e.supplier) !== String(supplier._id) || !acct.isLive(e) || !acct.CREDIT_TYPES.has(e.type)) throw notFound("لا يوجد رصيد دائن (سلفة/دفعة) سارٍ بهذا المعرّف لهذا التاجر.", "CREDIT_NOT_FOUND");
    if (e.currency !== p.currency) throw conflict("السلفة بعملة تختلف عن عملة الفاتورة. خصّصها من صفحة التاجر بتأكيد صريح وسعر صرف مُدخَل.", "CROSS_CURRENCY_CONFIRM_REQUIRED");
    if (!validAmount(p.currency, adv.amount)) throw badRequest("مبلغ تخصيص السلفة غير صالح.", "INVALID_AMOUNT_PRECISION");
    const amountMinor = toMinorC(p.currency, adv.amount);
    const state = acct.creditStates([e], await allocRepo.forEntry(e._id, ctx), [invoice]).find((c) => String(c.entry._id) === String(e._id));
    if (amountMinor > state.availableMinor) throw conflict(`المبلغ يتجاوز الرصيد المتاح في ${e.ref} (${M(e.currency, state.availableMinor)}).`, "ALLOCATION_EXCEEDS_CREDIT");
    out.allocations.push(await postAllocation({ supplier: supplier._id, entry: e, invoice, amountMinor, source: "manual", note: `سلفة عند الاستلام`, idempotencyKey: `${key}:adv${i++}`, actor }, ctx));
    out.advanceMinor += amountMinor;
  }
  const total = m.amountMinor, covered = out.paidMinor + out.advanceMinor;
  if (covered > total) throw conflict("المدفوع مع السلف يتجاوز قيمة الفاتورة. سجّل الزيادة كسلفة منفصلة من صفحة التاجر.", "INVOICE_OVERPAID");
  out.outstandingMinor = total - covered;
  out.payStatus = covered === 0 ? "unpaid" : covered === total ? "paid" : "partial";
  return out;
}

// عرض نتيجة postReceiptPurchase (كل رقم بعملته)
function presentReceiptPurchase(r) {
  const cur = r.invoice.currency;
  return {
    invoice: { id: String(r.invoice._id), invoiceNo: r.invoice.invoiceNo, currency: cur, amount: M(cur, acct.invoiceMinorOf(r.invoice)), ref: r.entry.ref },
    paymentRef: r.cashEntry?.ref || null,
    cashPaid: M(cur, r.paidMinor), advanceApplied: M(cur, r.advanceMinor), outstanding: M(cur, r.outstandingMinor), payStatus: r.payStatus,
    allocationRefs: r.allocations.map((a) => a.ref),
  };
}

// قراءة تسلسلية عمداً: عملية متوازية على نفس جلسة المعاملة يرفضها MongoDB
async function loadState(supplierId, ctx) {
  const entries = await entryRepo.allForSupplier(supplierId, ctx);
  const invoices = await invoiceRepo.listBySupplier(supplierId, ctx);
  const allocations = await allocRepo.allForSupplier(supplierId, ctx);
  return { entries, invoices, allocations };
}

async function listInvoices(supplierId) {
  await supplierService.requireSupplier(supplierId);
  const { entries, invoices, allocations } = await loadState(supplierId);
  const states = acct.invoiceStates(invoices, allocations, entries);
  return { items: invoices.map((i) => presentInvoice(i, states.get(String(i._id)))) };
}

async function requireInvoice(supplierId, invoiceId, ctx) {
  const inv = await invoiceRepo.findById(invoiceId, ctx);
  if (!inv || String(inv.supplier) !== String(supplierId)) throw notFound("فاتورة التاجر غير موجودة.", "SUPPLIER_INVOICE_NOT_FOUND");
  if (inv.status !== "posted") throw conflict("هذه الفاتورة معكوسة.", "INVOICE_REVERSED");
  return inv;
}

// ---------------------------------------------------------------- دفعات وسلف وإشعارات
// اتساق صريح لمبلغين وسعر صرف مُدخَل (ل.س لكل 1$): لا يُشتق أي مبلغ تلقائياً
function checkRate(usdMinor, sypAmount, rate) {
  const expected = (usdMinor / 100) * rate;
  if (Math.abs(sypAmount - expected) > Math.max(1, rate / 100)) throw badRequest("المبلغان وسعر الصرف المُدخَلان غير متسقين.", "RATE_AMOUNT_MISMATCH");
}

// خطة تخصيص دفعة مرتبطة بفاتورة: نفس العملة مباشرة؛ وإلا تأكيد صريح + مبلغ التسوية بعملة الفاتورة + سعر صرف مُدخَل
function crossPlan(type, m, invoice, cross) {
  if (m.currency === invoice.currency) return { amountMinor: m.amountMinor, creditMinor: m.amountMinor, crossCurrency: false, rate: 0 };
  if (type !== "payment") throw conflict("الإشعارات الدائنة تُربط بفاتورة بنفس عملتها فقط.", "CROSS_CURRENCY_NOT_ALLOWED");
  if (!cross) throw conflict(`الفاتورة بعملة ${invoice.currency} والدفعة بعملة ${m.currency}. الدفع بعملة مختلفة يتطلب تأكيداً صريحاً مع مبلغ التسوية وسعر الصرف المُدخَل، أو ادفع بعملة الفاتورة.`, "CROSS_CURRENCY_CONFIRM_REQUIRED");
  if (!validAmount(invoice.currency, cross.settlesAmount)) throw badRequest("مبلغ التسوية بعملة الفاتورة غير صالح.", "INVALID_AMOUNT_PRECISION");
  const settlesMinor = toMinorC(invoice.currency, cross.settlesAmount);
  const usdMinor = m.currency === "USD" ? m.amountMinor : settlesMinor;
  const sypAmount = m.currency === "SYP" ? m.amount : cross.settlesAmount;
  checkRate(usdMinor, sypAmount, cross.rate);
  return { amountMinor: settlesMinor, creditMinor: m.amountMinor, crossCurrency: true, rate: cross.rate };
}

async function recordCredit(supplierId, type, body, actor, label) {
  const supplier = await supplierService.requireSupplier(supplierId);
  if (!supplier.active) throw conflict("التاجر معطّل: فعّله قبل تسجيل قيود جديدة.", "SUPPLIER_INACTIVE");
  const prior = await priorByKey(body.idempotencyKey, supplier._id, [type]);
  if (prior) return { duplicate: true, entry: presentEntry(prior) };

  const invoice = body.invoiceId ? await requireInvoice(supplier._id, body.invoiceId) : null;
  const m = toMoney(body);
  let plan = null;
  if (invoice) {
    plan = crossPlan(type, m, invoice, body.crossCurrency);
    const { entries, allocations } = await loadState(supplier._id);
    const left = acct.invoiceStates([invoice], allocations, entries).get(String(invoice._id)).outstandingMinor;
    if (plan.amountMinor > left) throw conflict(`المبلغ (${M(invoice.currency, plan.amountMinor)} ${invoice.currency}) يتجاوز المتبقي على الفاتورة (${M(invoice.currency, left)} ${invoice.currency}). سجّل الزيادة كسلفة.`, "INVOICE_OVERPAID");
  }
  try {
    const entry = await runAtomic(async (ctx) => {
      const e = await postEntry(
        {
          supplier: supplier._id, type, ...m, date: body.date, invoice: invoice?._id, idempotencyKey: body.idempotencyKey, note: body.note || label, createdBy: actorOf(actor),
          ...(plan?.crossCurrency ? { crossCurrency: { invoiceCurrency: invoice.currency, settlesMinor: plan.amountMinor, rate: plan.rate } } : {}),
        },
        ctx
      );
      // الدفعة/السلفة وحدهما تُخرجان نقداً فعلياً من صندوق عملتهما (الإشعارات والائتمان لا تحرك النقد)
      if (acct.CASH_OUT_TYPES.has(type)) await cashService.recordSupplierPayment(e, actor, ctx);
      // الدفعة المرتبطة بفاتورة تُخصَّص عليها بسجل تخصيص مباشر. التخصيص لا ينشئ حركة نقد ثانية
      if (invoice) await postAllocation({ supplier: supplier._id, entry: e, invoice, ...plan, source: "direct", actor }, ctx);
      return e;
    });
    return { duplicate: false, entry: presentEntry(entry) };
  } catch (err) {
    if (err.code === 11000) {
      const again = await entryRepo.findByKey(body.idempotencyKey);
      if (again) return { duplicate: true, entry: presentEntry(again) };
    }
    throw err;
  }
}

const recordPayment = (id, body, actor) => recordCredit(id, "payment", body, actor, "دفعة للتاجر");
const recordAdvance = (id, body, actor) => recordCredit(id, "advance", body, actor, "سلفة للتاجر");

async function recordAdjustment(supplierId, { kind, ...body }, actor) {
  if (kind !== "adjustment") return recordCredit(supplierId, "credit", body, actor, "إشعار دائن");
  const supplier = await supplierService.requireSupplier(supplierId);
  if (!supplier.active) throw conflict("التاجر معطّل: فعّله قبل تسجيل قيود جديدة.", "SUPPLIER_INACTIVE");
  const prior = await priorByKey(body.idempotencyKey, supplier._id, ["adjustment"]);
  if (prior) return { duplicate: true, entry: presentEntry(prior) };
  if (body.invoiceId) throw badRequest("التسوية المدينة لا تُربط بفاتورة.", "INVALID_LINK");
  const m = toMoney(body);
  try {
    const entry = await runAtomic((ctx) => postEntry({ supplier: supplier._id, type: "adjustment", ...m, date: body.date, idempotencyKey: body.idempotencyKey, note: body.note, createdBy: actorOf(actor) }, ctx));
    return { duplicate: false, entry: presentEntry(entry) };
  } catch (err) {
    if (err.code === 11000) {
      const again = await entryRepo.findByKey(body.idempotencyKey);
      if (again) return { duplicate: true, entry: presentEntry(again) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- التخصيص (السلف/الأرصدة الدائنة على الفواتير)
async function allocate(supplierId, { entryId, invoiceId, amount, creditAmount, crossCurrency, rate, idempotencyKey, note }, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const prior = await allocRepo.findByKey(idempotencyKey);
  if (prior) {
    if (String(prior.supplier) !== String(supplier._id)) throw conflict("مفتاح الطلب مستخدم لعملية أخرى.", "IDEMPOTENCY_MISMATCH");
    return { duplicate: true, allocation: await presentOne(prior) };
  }
  const entry = await entryRepo.findById(entryId);
  if (!entry || String(entry.supplier) !== String(supplier._id) || !acct.isLive(entry) || !acct.CREDIT_TYPES.has(entry.type)) throw notFound("لا يوجد رصيد دائن (دفعة/سلفة/إشعار) سارٍ بهذا المعرّف لهذا التاجر.", "CREDIT_NOT_FOUND");
  const invoice = await requireInvoice(supplier._id, invoiceId);
  if (!validAmount(invoice.currency, amount)) throw badRequest("مبلغ التخصيص غير صالح بعملة الفاتورة.", "INVALID_AMOUNT_PRECISION");
  const amountMinor = toMinorC(invoice.currency, amount);

  let creditMinor = amountMinor, cross = false, usedRate = 0;
  if (entry.currency !== invoice.currency) {
    // رصيد بعملة تختلف عن عملة الفاتورة: تأكيد صريح ومبلغان وسعر صرف مُدخَل، دون أي اشتقاق صامت
    if (!crossCurrency) throw conflict(`الرصيد بعملة ${entry.currency} والفاتورة بعملة ${invoice.currency}. التخصيص عبر العملتين يتطلب تأكيداً صريحاً (مبلغ كل عملة وسعر الصرف).`, "CROSS_CURRENCY_CONFIRM_REQUIRED");
    if (entry.type !== "payment" && entry.type !== "advance") throw conflict("الإشعارات الدائنة لا تُخصَّص عبر العملتين.", "CROSS_CURRENCY_NOT_ALLOWED");
    if (!(creditAmount > 0) || !(rate > 0)) throw badRequest("أدخل مبلغ الرصيد المستهلك وسعر الصرف صراحةً.", "RATE_REQUIRED");
    if (!validAmount(entry.currency, creditAmount)) throw badRequest("مبلغ الرصيد غير صالح بعملته.", "INVALID_AMOUNT_PRECISION");
    creditMinor = toMinorC(entry.currency, creditAmount);
    checkRate(invoice.currency === "USD" ? amountMinor : creditMinor, invoice.currency === "SYP" ? amount : creditAmount, rate);
    cross = true; usedRate = rate;
  } else if (creditAmount !== undefined && toMinorC(entry.currency, creditAmount) !== amountMinor) {
    throw badRequest("عند اتحاد العملة يتساوى المبلغان.", "AMOUNT_MISMATCH");
  }
  const { entries, allocations } = await loadState(supplier._id);
  const avail = acct.creditStates([entry], allocations, [invoice]).find((c) => String(c.entry._id) === String(entry._id)).availableMinor;
  const left = acct.invoiceStates([invoice], allocations, entries).get(String(invoice._id)).outstandingMinor;
  if (creditMinor > avail) throw conflict(`المبلغ يتجاوز الرصيد الدائن المتاح (${M(entry.currency, avail)} ${entry.currency}).`, "ALLOCATION_EXCEEDS_CREDIT");
  if (amountMinor > left) throw conflict(`المبلغ يتجاوز المتبقي على الفاتورة (${M(invoice.currency, left)} ${invoice.currency}).`, "INVOICE_OVERPAID");
  try {
    const a = await runAtomic((ctx) => postAllocation({ supplier: supplier._id, entry, invoice, amountMinor, creditMinor, crossCurrency: cross, rate: usedRate, source: "manual", note, idempotencyKey, actor }, ctx));
    return { duplicate: false, allocation: await presentOne(a) };
  } catch (err) {
    if (err.code === 11000) {
      const again = await allocRepo.findByKey(idempotencyKey);
      if (again) return { duplicate: true, allocation: await presentOne(again) };
    }
    throw err;
  }
}

// تطبيق تلقائي صريح بسياسة موثّقة: الأقدم على الأقدم وبنفس العملة فقط. يُنشئ سجلات تخصيص ظاهرة ولا يعدّل شيئاً آخر
async function autoAllocate(supplierId, { entryId } = {}, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const created = await runAtomic(async (ctx) => {
    const { entries, invoices, allocations } = await loadState(supplier._id, ctx);
    const plan = acct.planAutoAllocation(invoices, entries, allocations, entryId);
    const out = [];
    for (const p of plan) out.push(await postAllocation({ supplier: supplier._id, entry: p.entry, invoice: p.invoice, amountMinor: p.amountMinor, source: "auto", note: "تطبيق تلقائي: الأقدم فالأحدث وبنفس العملة", actor }, ctx));
    return out;
  });
  const items = [];
  for (const a of created) items.push(await presentOne(a));
  const applied = { USD: 0, SYP: 0 };
  for (const a of created) applied[a.currency] += a.amountMinor;
  return { items, applied: { USD: M("USD", applied.USD), SYP: M("SYP", applied.SYP) } };
}

async function presentOne(a) {
  const e = await entryRepo.findById(a.entry);
  const i = await invoiceRepo.findById(a.invoice);
  return presentAllocation(a, { refs: new Map([[String(a.entry), e?.ref]]), invoices: new Map([[String(a.invoice), i]]) });
}

// فك تخصيص (سجل release جديد، الأصل يبقى موسوماً): يعيد الرصيد للفاتورة وللسلفة. لا حركة نقد
async function releaseInTx(alloc, reason, actor, ctx) {
  const rel = await allocRepo.create(
    {
      ref: fmt("ALC", await nextSeq("supplierAllocation", ctx)), supplier: alloc.supplier, kind: "release", entry: alloc.entry, invoice: alloc.invoice,
      currency: alloc.currency, amountMinor: alloc.amountMinor, creditCurrency: alloc.creditCurrency, creditMinor: alloc.creditMinor, crossCurrency: alloc.crossCurrency, rate: alloc.rate,
      source: "release", releases: alloc._id, note: reason, createdBy: actorOf(actor),
    },
    ctx
  );
  ctx.undo(() => allocRepo.deleteById(rel._id));
  const marked = await allocRepo.markReleased(alloc._id, rel._id, ctx);
  if (!marked) throw conflict("هذا التخصيص مُحرَّر مسبقاً.", "ALREADY_RELEASED");
  ctx.undo(() => allocRepo.unmarkReleased(alloc._id));
  return rel;
}

async function releaseAllocation(supplierId, allocId, { reason }, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const alloc = await allocRepo.findById(allocId);
  if (!alloc || String(alloc.supplier) !== String(supplier._id) || alloc.kind !== "apply") throw notFound("التخصيص غير موجود لهذا التاجر.", "ALLOCATION_NOT_FOUND");
  if (alloc.releasedBy) throw conflict("هذا التخصيص مُحرَّر مسبقاً.", "ALREADY_RELEASED");
  try {
    const rel = await runAtomic((ctx) => releaseInTx(alloc, reason, actor, ctx));
    return { allocation: await presentOne(rel) };
  } catch (err) {
    if (err.code === 11000) throw conflict("هذا التخصيص مُحرَّر مسبقاً.", "ALREADY_RELEASED");
    throw err;
  }
}

async function listAllocations(supplierId) {
  await supplierService.requireSupplier(supplierId);
  const { entries, invoices, allocations } = await loadState(supplierId);
  const refs = new Map(entries.map((e) => [String(e._id), e.ref]));
  const invMap = new Map(invoices.map((i) => [String(i._id), i]));
  const credits = acct.creditStates(entries, allocations, invoices).map((c) => ({
    ...presentEntry(c.entry, { invoices: invMap, refs }),
    allocated: M(c.currency, c.allocatedMinor), available: M(c.currency, c.availableMinor),
  }));
  return { credits, items: [...allocations].reverse().map((a) => presentAllocation(a, { refs, invoices: invMap })) };
}

// ---------------------------------------------------------------- عكس قيد (لا تعديل ولا حذف)
// داخل وحدة ذرّية: يحرّر تخصيصات الرصيد الدائن المعكوس، ويعكس حركة النقد المقابلة لدفعة/سلفة، ويرفض عكس فاتورة عليها تخصيصات سارية
async function reverseInTx(orig, reason, actor, ctx) {
  if (acct.CREDIT_TYPES.has(orig.type)) {
    for (const a of (await allocRepo.forEntry(orig._id, ctx)).filter(acct.isLiveAlloc)) await releaseInTx(a, `تحرير تلقائي بسبب عكس ${orig.ref}`, actor, ctx);
  }
  if (orig.type === "purchase" && orig.invoice) {
    const live = (await allocRepo.forInvoice(orig.invoice, ctx)).filter(acct.isLiveAlloc);
    if (live.length) throw conflict("على هذه الفاتورة تخصيصات سارية. حرّرها (أو اعكس دفعاتها) أولاً ثم اعكس الفاتورة.", "REVERSE_PAYMENTS_FIRST");
  }
  const rev = await postEntry(
    {
      supplier: orig.supplier, type: "reversal", signedMinor: -acct.signedMinorOf(orig), currency: orig.currency, rate: orig.rate, amountMinor: acct.amountMinorOf(orig),
      date: new Date(), note: `عكس ${orig.ref}: ${reason}`, invoice: orig.invoice, supplierReturn: orig.supplierReturn, reverses: orig._id, createdBy: actorOf(actor),
    },
    ctx
  );
  const marked = await entryRepo.markReversed(orig._id, rev._id, ctx);
  if (!marked) throw conflict("هذا القيد معكوس مسبقاً.", "ALREADY_REVERSED");
  ctx.undo(() => entryRepo.unmarkReversed(orig._id));
  if (acct.CASH_OUT_TYPES.has(orig.type)) await cashService.reverseSupplierPayment(orig, actor, ctx);
  if (orig.type === "purchase" && orig.invoice) {
    const inv = await invoiceRepo.markReversed(orig.invoice, ctx);
    if (inv) ctx.undo(() => invoiceRepo.unmarkReversed(orig.invoice));
  }
  return rev;
}

async function checkReversible(supplierId, entryId) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const orig = await entryRepo.findById(entryId);
  if (!orig || String(orig.supplier) !== String(supplier._id)) throw notFound("القيد غير موجود لهذا التاجر.", "ENTRY_NOT_FOUND");
  if (orig.type === "reversal") throw conflict("لا يمكن عكس قيد عكسي. سجّل قيداً جديداً صحيحاً بدلاً منه.", "CANNOT_REVERSE_REVERSAL");
  if (orig.reversedBy) throw conflict("هذا القيد معكوس مسبقاً.", "ALREADY_REVERSED");
  return orig;
}

async function reverseEntry(supplierId, entryId, { reason }, actor) {
  const orig = await checkReversible(supplierId, entryId);
  if (orig.invoice && orig.type === "purchase") {
    const inv = await invoiceRepo.findById(orig.invoice);
    if (inv?.kind === "consignment_settlement") throw conflict("هذه الفاتورة من تسوية بضاعة أمانة: اعكس التسوية نفسها من تبويب «تسويات الأمانة».", "REVERSE_VIA_SETTLEMENT");
  }
  try {
    const rev = await runAtomic((ctx) => reverseInTx(orig, reason, actor, ctx));
    return { entry: presentEntry(rev) };
  } catch (err) {
    if (err.code === 11000) throw conflict("هذا القيد معكوس مسبقاً.", "ALREADY_REVERSED");
    throw err;
  }
}

// ---------------------------------------------------------------- كشف الحساب
async function statement(supplierId, q) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const { entries, invoices, allocations } = await loadState(supplier._id);
  const returns = await returnRepo.listBySupplier(supplier._id, 500);
  const settlements = await settlementRepo.listBySupplier(supplier._id, 500);
  const running = acct.withRunningBalance(entries);
  const refs = new Map(entries.map((e) => [String(e._id), e.ref]));
  const typeOf = new Map(entries.map((e) => [String(e._id), e.type]));
  const settlementOf = new Map();
  for (const s of settlements) { if (s.entry) settlementOf.set(String(s.entry), { id: String(s._id), ref: s.ref }); if (s.reversal?.entry) settlementOf.set(String(s.reversal.entry), { id: String(s._id), ref: s.ref }); }
  const ctx = { refs, settlementOf, typeOf, invoices: new Map(invoices.map((i) => [String(i._id), i])), returns: new Map(returns.map((r) => [String(r._id), r])) };

  let rows = running;
  if (q.type) rows = rows.filter((e) => e.type === q.type);
  if (q.currency) rows = rows.filter((e) => e.currency === q.currency);
  if (q.from) rows = rows.filter((e) => e.date >= new Date(q.from));
  if (q.to) rows = rows.filter((e) => e.date < new Date(q.to));
  rows = [...rows].reverse();
  const paging = parsePaging(q, 25);
  const page = rows.slice(paging.skip, paging.skip + paging.limit);

  const summary = acct.summarize(entries, allocations, invoices);
  const states = acct.invoiceStates(invoices, allocations, entries);
  const credits = acct.creditStates(entries, allocations, invoices);
  const positions = {}, byCurrency = {};
  for (const c of acct.CURS) {
    const s = summary[c];
    positions[c] = { grossPayable: M(c, s.grossMinor), advance: M(c, s.advanceMinor), net: M(c, s.netMinor) };
    byCurrency[c] = { invoiced: M(c, s.invoicedMinor + s.adjustmentsMinor), credits: M(c, s.creditsMinor), allocatedToInvoices: M(c, s.allocatedInvoiceMinor), creditConsumed: M(c, s.allocatedCreditMinor) };
  }
  return {
    supplier: supplierService.present(supplier, { positions, status: summary.status }),
    summary: {
      status: summary.status, positions, byCurrency,
      openInvoices: [...states.values()].filter((s) => s.outstandingMinor > 0).length,
      unallocatedCredits: credits.filter((c) => c.availableMinor > 0).length,
    },
    ...pageResult(page.map((e) => presentEntry(e, ctx)), rows.length, paging),
  };
}

module.exports = {
  toMoney, postEntry, postAllocation, presentEntry, presentInvoice, createInvoice, postInvoiceTx, listInvoices, requireInvoice, loadState,
  recordPayment, recordAdvance, recordAdjustment, allocate, autoAllocate, releaseAllocation, listAllocations,
  postReceiptPurchase, presentReceiptPurchase, reverseEntry, reverseInTx, checkReversible, statement, priorByKey, fmt, actorOf, crossPlan,
};
