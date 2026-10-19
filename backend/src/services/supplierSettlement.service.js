const seriesRepo = require("../repositories/series.repository");
const movementRepo = require("../repositories/movement.repository");
const entryRepo = require("../repositories/supplierEntry.repository");
const invoiceRepo = require("../repositories/supplierInvoice.repository");
const settlementRepo = require("../repositories/supplierSettlement.repository");
const { nextSeq } = require("../repositories/counter.repository");
const supplierService = require("./supplier.service");
const ledger = require("./supplierLedger.service");
const { toMinorC, fromMinorC } = require("../utils/money");
const { normalizeSize } = require("../utils/sizes");
const { runAtomic } = require("../utils/unitOfWork");
const { notFound, conflict, badRequest } = require("../utils/errors");

const M = fromMinorC;

// ---------------------------------------------------------------- الكميات المباعة القابلة للتسوية
// المباع الصافي لكل (رتل، مقاس) من حركات المخزون المرتبطة بالأرتال: بيع − إلغاء فاتورة − مرتجع سليم.
// settledQty على مقاس الرتل ما سُوِّي سابقاً. القابل للتسوية = المباع − المسوّى، ولا يتجاوز ذلك أبداً.
// القيم التقديرية بعملة سعر الاتفاق لكل صف (لا تحويل ولا جمع بين العملتين).
async function eligible(supplierId) {
  await supplierService.requireSupplier(supplierId);
  const all = await seriesRepo.consignmentSeries(supplierId);
  const sold = await movementRepo.netSoldBySeries(all.map((s) => s._id));
  const rows = [];
  for (const s of all) {
    for (const sz of s.sizes) {
      const net = sold.get(`${s._id}|${sz.size}`) || 0;
      const settled = sz.settledQty || 0;
      if (net <= 0 && settled <= 0) continue;
      const price = s.consignment?.price?.amount > 0 ? s.consignment.price : null;
      const settleable = Math.max(0, net - settled);
      rows.push({
        seriesId: String(s._id), seriesNo: s.seriesNo, modelNumber: s.modelNumber, name: s.name, location: s.location, size: sz.size,
        sold: net, settled, settleable, overSettled: settled > net,
        priced: !!price, price: price ? { amount: price.amount, currency: price.currency } : null,
        estimated: price ? { amount: M(price.currency, settleable * toMinorC(price.currency, price.amount)), currency: price.currency } : null,
      });
    }
  }
  const est = { USD: 0, SYP: 0 };
  for (const r of rows) if (r.estimated) est[r.estimated.currency] += r.estimated.amount;
  return {
    items: rows,
    summary: {
      settleablePieces: rows.reduce((n, r) => n + r.settleable, 0),
      unpricedSettleablePieces: rows.filter((r) => !r.priced).reduce((n, r) => n + r.settleable, 0),
      overSettledLines: rows.filter((r) => r.overSettled).length,
      estimated: { USD: Math.round(est.USD * 100) / 100, SYP: Math.round(est.SYP) },
    },
  };
}

const presentSettlement = (s, refs = {}) => {
  const cur = s.currency || s.items[0]?.currency || "USD";
  return {
    id: String(s._id), ref: s.ref, status: s.status, note: s.note || "", currency: cur,
    items: s.items.map((i) => ({
      seriesNo: i.seriesNo, modelNumber: i.modelNumber, name: i.name, size: i.size, qty: i.qty, unitAmount: i.unitAmount, currency: i.currency,
      lineAmount: i.lineMinor != null ? M(i.currency, i.lineMinor) : i.lineAmount,
    })),
    totalQty: s.totalQty, total: s.totalMinor != null ? M(cur, s.totalMinor) : 0,
    invoiceNo: refs.invoices?.get(String(s.invoice))?.invoiceNo || null,
    entryRef: refs.entries?.get(String(s.entry)) || null,
    reversal: s.reversal ? { at: s.reversal.at, reason: s.reversal.reason, by: s.reversal.by?.name || "" } : null,
    createdBy: s.createdBy?.name || "", createdAt: s.createdAt,
  };
};

async function list(supplierId) {
  await supplierService.requireSupplier(supplierId);
  const items = await settlementRepo.listBySupplier(supplierId);
  const invoices = await invoiceRepo.listBySupplier(supplierId);
  const entries = await entryRepo.allForSupplier(supplierId);
  const refs = { invoices: new Map(invoices.map((i) => [String(i._id), i])), entries: new Map(entries.map((e) => [String(e._id), e.ref])) };
  return { items: items.map((s) => presentSettlement(s, refs)) };
}

// ---------------------------------------------------------------- تسجيل تسوية (وحده ما ينشئ التزاماً للتاجر؛ لا أثر على النقد)
async function post(supplierId, body, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);
  if (!supplier.active) throw conflict("التاجر معطّل: فعّله قبل تسجيل تسويات جديدة.", "SUPPLIER_INACTIVE");

  const prior = await settlementRepo.findByKey(body.idempotencyKey);
  if (prior) {
    if (String(prior.supplier) !== String(supplier._id)) throw conflict("مفتاح الطلب مستخدم لعملية أخرى.", "IDEMPOTENCY_MISMATCH");
    if (prior.status !== "pending") return { duplicate: true, settlement: presentSettlement(prior) };
    throw conflict("هذه التسوية قيد المعالجة. لا تُعد الإرسال.", "SETTLEMENT_IN_PROGRESS");
  }

  const merged = new Map();
  for (const i of body.items) {
    const size = normalizeSize(i.size);
    const k = `${i.seriesId}|${size}`;
    merged.set(k, { seriesId: i.seriesId, size, qty: (merged.get(k)?.qty || 0) + i.qty });
  }
  const seriesDocs = new Map();
  for (const it of merged.values()) {
    if (!seriesDocs.has(it.seriesId)) seriesDocs.set(it.seriesId, await seriesRepo.findById(it.seriesId));
  }
  const sold = await movementRepo.netSoldBySeries([...seriesDocs.keys()]);

  const lines = [];
  for (const it of merged.values()) {
    const s = seriesDocs.get(it.seriesId);
    if (!s) throw notFound("أحد الأرتال المحددة غير موجود.", "SERIES_NOT_FOUND");
    if (s.ownership !== "consignment" || String(s.supplier) !== String(supplier._id)) throw conflict(`الرتل ${s.seriesNo} ليس بضاعة أمانة لهذا التاجر.`, "NOT_SUPPLIER_CONSIGNMENT");
    const price = s.consignment?.price;
    if (!(price?.amount > 0)) throw conflict(`لا يوجد سعر اتفاق مسجّل للرتل ${s.seriesNo}. سجّل السعر المتفق عليه أولاً ولا تُخمَّن القيمة.`, "CONSIGNMENT_PRICE_MISSING");
    const sz = s.sizes.find((x) => x.size === it.size);
    const net = sold.get(`${s._id}|${it.size}`) || 0;
    const settleable = net - (sz?.settledQty || 0);
    if (!sz || it.qty > settleable) throw conflict(`المقاس ${it.size} من الرتل ${s.seriesNo}: القابل للتسوية ${Math.max(0, settleable)} والمطلوب ${it.qty} (المباع ${net}).`, "CONSIGNMENT_OVER_SETTLEMENT");
    // لقطة السعر بعملته: الكمية × سعر القطعة (أعداد صحيحة بالوحدة الصغرى). لا تحويل لأي عملة
    const lineMinor = it.qty * toMinorC(price.currency, price.amount);
    lines.push({
      series: s._id, seriesNo: s.seriesNo, model: s.model, modelNumber: s.modelNumber, name: s.name, size: it.size, qty: it.qty,
      unitAmount: price.amount, currency: price.currency, rate: price.rate || 0, lineAmount: M(price.currency, lineMinor), lineMinor, _net: net,
    });
  }
  // تسوية بعملة واحدة: الدولار والليرة لا يُخلطان في التزام واحد
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) throw badRequest("أسعار الاتفاق للبنود المحددة بعملتين مختلفتين. سجّل تسوية منفصلة لكل عملة.", "MIXED_CURRENCY_SETTLEMENT");
  const currency = lines[0].currency;
  const totalMinor = lines.reduce((n, l) => n + l.lineMinor, 0);
  if (!(totalMinor > 0)) throw badRequest("قيمة التسوية صفر.", "AMOUNT_TOO_SMALL");
  const totalQty = lines.reduce((n, l) => n + l.qty, 0);

  const number = await nextSeq("supplierSettlement");
  const ref = ledger.fmt("SST", number);
  let claim;
  try {
    claim = await settlementRepo.create({
      number, ref, supplier: supplier._id, idempotencyKey: body.idempotencyKey, currency, items: lines.map(({ _net, ...l }) => l), totalQty, totalMinor,
      note: body.note || "", status: "pending", createdBy: ledger.actorOf(actor),
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const again = await settlementRepo.findByKey(body.idempotencyKey);
    if (again && again.status !== "pending" && String(again.supplier) === String(supplier._id)) return { duplicate: true, settlement: presentSettlement(again) };
    throw conflict("هذه التسوية قيد المعالجة. لا تُعد الإرسال.", "SETTLEMENT_IN_PROGRESS");
  }

  try {
    const out = await runAtomic(async (ctx) => {
      // تسوية شرطية ذرّية لكل بند: لا تسوية مزدوجة حتى لو وصل طلبان معاً
      for (const l of lines) {
        const ok = await seriesRepo.settleQty(l.series, l.size, l.qty, l._net - l.qty, ctx);
        if (!ok) throw conflict(`المقاس ${l.size} من الرتل ${l.seriesNo} سُوِّي مسبقاً (طلب متزامن؟).`, "CONSIGNMENT_OVER_SETTLEMENT");
        ctx.undo(() => seriesRepo.unsettleQty(l.series, l.size, l.qty, null));
      }
      const m = { currency, amount: M(currency, totalMinor), amountMinor: totalMinor, rate: 0 };
      return ledger.postInvoiceTx(
        supplier,
        {
          invoiceNo: ref, invoiceKey: ref, kind: "consignment_settlement", invoiceDate: new Date().toISOString(), note: body.note || "",
          seriesNos: [...new Set(lines.map((l) => l.seriesNo))], m, idempotencyKey: `sst:${body.idempotencyKey}`, entryNote: `تسوية بضاعة أمانة مباعة ${ref} (${totalQty} قطعة)`,
        },
        actor,
        ctx
      );
    });
    await settlementRepo.markPosted(claim._id, out.invoice._id, out.entry._id);
    const posted = await settlementRepo.findById(claim._id);
    return { duplicate: false, settlement: presentSettlement(posted, { invoices: new Map([[String(out.invoice._id), out.invoice]]), entries: new Map([[String(out.entry._id), out.entry.ref]]) }), entry: ledger.presentEntry(out.entry) };
  } catch (err) {
    await settlementRepo.deleteById(claim._id); // يسمح بإعادة المحاولة بنفس المفتاح بعد فشل حقيقي
    throw err;
  }
}

// ---------------------------------------------------------------- عكس تسوية: القيد المالي + تحرير الكميات المسوّاة، والسجل الأصلي يبقى
async function reverse(supplierId, settlementId, { reason }, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const s = await settlementRepo.findById(settlementId);
  if (!s || String(s.supplier) !== String(supplier._id)) throw notFound("التسوية غير موجودة لهذا التاجر.", "SETTLEMENT_NOT_FOUND");
  if (s.status !== "posted") throw conflict("هذه التسوية معكوسة مسبقاً.", "ALREADY_REVERSED");
  const entry = await entryRepo.findById(s.entry);
  try {
    await runAtomic(async (ctx) => {
      const rev = await ledger.reverseInTx(entry, reason, actor, ctx);
      for (const l of s.items) {
        const ok = await seriesRepo.unsettleQty(l.series, l.size, l.qty, ctx);
        if (!ok) throw conflict(`تعذّر تحرير الكمية المسوّاة للرتل ${l.seriesNo} (بيانات غير متسقة: راجع يدوياً).`, "SETTLEMENT_INCONSISTENT");
        ctx.undo(() => seriesRepo.settleQty(l.series, l.size, l.qty, Number.MAX_SAFE_INTEGER, null));
      }
      const marked = await settlementRepo.markReversed(s._id, { at: new Date(), reason, by: ledger.actorOf(actor), entry: rev._id }, ctx);
      if (!marked) throw conflict("هذه التسوية معكوسة مسبقاً.", "ALREADY_REVERSED");
      ctx.undo(() => settlementRepo.unmarkReversed(s._id));
    });
  } catch (err) {
    if (err.code === 11000) throw conflict("هذه التسوية معكوسة مسبقاً.", "ALREADY_REVERSED");
    throw err;
  }
  return { settlement: presentSettlement(await settlementRepo.findById(s._id)) };
}

// ---------------------------------------------------------------- سعر الاتفاق (تسجيل أول / تعديل مصرَّح به) بعملته الأصلية
async function setPrices(supplierId, { seriesIds, price, adjust, reason }, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);
  const snap = supplierService.resolvePrice(price);
  const ids = [...new Set(seriesIds)];
  const docs = [];
  for (const id of ids) {
    const s = await seriesRepo.findById(id);
    if (!s) throw notFound("أحد الأرتال المحددة غير موجود.", "SERIES_NOT_FOUND");
    if (s.ownership !== "consignment" || String(s.supplier) !== String(supplier._id)) throw conflict(`الرتل ${s.seriesNo} ليس بضاعة أمانة لهذا التاجر.`, "NOT_SUPPLIER_CONSIGNMENT");
    const has = s.consignment?.price?.amount > 0;
    if (has && !adjust) throw conflict(`للرتل ${s.seriesNo} سعر اتفاق مسجّل. التعديل يتطلب تأكيد «تعديل مصرَّح به» مع سبب.`, "CONSIGNMENT_PRICE_EXISTS");
    if (!has && adjust) throw conflict(`الرتل ${s.seriesNo} بلا سعر مسجّل: سجّله كاتفاق أول لا كتعديل.`, "CONSIGNMENT_PRICE_MISSING");
    docs.push(s);
  }
  await runAtomic(async (ctx) => {
    for (const s of docs) {
      const prev = s.consignment?.price?.amount > 0 ? { amount: s.consignment.price.amount, currency: s.consignment.price.currency, rate: s.consignment.price.rate || 0 } : undefined;
      const entry = { kind: adjust ? "adjust" : "set", at: new Date(), reason, by: ledger.actorOf(actor), ...(prev ? { previous: prev } : {}), price: snap };
      const ok = await seriesRepo.setConsignmentPrice(s._id, supplier._id, { price: snap, entry, expectPrice: !!adjust }, ctx);
      if (!ok) throw conflict(`تغيّر سعر الرتل ${s.seriesNo} أثناء العملية. أعد المحاولة.`, "CONFLICT");
      ctx.undo(() => seriesRepo.revertConsignmentPrice(s._id, prev));
    }
  });
  return { updated: docs.map((s) => s.seriesNo), price: snap };
}

module.exports = { eligible, list, post, reverse, setPrices };
