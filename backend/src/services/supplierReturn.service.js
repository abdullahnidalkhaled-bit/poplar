const seriesRepo = require("../repositories/series.repository");
const productRepo = require("../repositories/productModel.repository");
const returnRepo = require("../repositories/supplierReturn.repository");
const { nextSeq } = require("../repositories/counter.repository");
const supplierService = require("./supplier.service");
const ledger = require("./supplierLedger.service");
const movementRepo = require("../repositories/movement.repository");
const availability = require("./availability.service");
const movementService = require("./movement.service");
const { normalizeText } = require("../utils/text");
const { normalizeSize } = require("../utils/sizes");
const { normalizeModelNumber } = require("../utils/modelNumber");
const { toMinorC, fromMinorC } = require("../utils/money");
const acct = require("../utils/supplierAccount");
const { runAtomic } = require("../utils/unitOfWork");
const { notFound, conflict } = require("../utils/errors");

const dk = (loc) => (loc === "shop" ? "shopDelta" : "warehouseDelta");
const formatRef = (n) => `SRT-${String(n).padStart(6, "0")}`;

// ---------------------------------------------------------------- بضاعة الأمانة لدى المحل
const presentSeries = (s) => ({
  id: String(s._id),
  seriesNo: s.seriesNo,
  modelId: String(s.model),
  modelNumber: s.modelNumber,
  name: s.name,
  location: s.location,
  kind: s.kind,
  status: s.status,
  receivedAt: s.receivedAt,
  shipmentRef: s.shipmentRef || "",
  price: s.consignment?.price?.amount > 0 ? { amount: s.consignment.price.amount, currency: s.consignment.price.currency, rate: s.consignment.price.rate || 0 } : null,
  priceHistory: (s.consignment?.history || []).map((h) => ({ kind: h.kind, at: h.at, reason: h.reason || "", by: h.by?.name || "", previous: h.previous || null, price: h.price })),
  remaining: s.remaining,
  value: s.agreedAmount == null ? null : { amount: fromMinorC(s.agreedCurrency, s.remaining * toMinorC(s.agreedCurrency, s.agreedAmount)), currency: s.agreedCurrency },
  sizes: s.sizes.filter((x) => x.qty > 0).map((x) => ({ size: x.size, qty: x.qty })).sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true })),
});

/**
 * بضاعة الأمانة لتاجر: الأرتال المؤهلة للإرجاع + ملخص لكل موديل.
 * مستلم − متبقٍ − مُرجَع = مباع/تالف/غيره (لا يُخزَّن شيء: كله مشتق من الأرتال وسجل الإرجاع، فلا عدّ مزدوج).
 * ملاحظة: النقل بين المحل والمستودع لا يغيّر الإجمالي (الأرتال المشتقة ترث الملكية).
 */
async function consignment(supplierId, q = {}) {
  await supplierService.requireSupplier(supplierId);
  const all = await seriesRepo.consignmentSeries(supplierId);
  const returned = await returnRepo.returnedByModel(supplierId);
  const sold = await movementRepo.netSoldBySeries(all.map((s) => s._id)); // "seriesId|size" -> صافي المباع

  const byModel = new Map();
  for (const s of all) {
    const k = String(s.model);
    const row = byModel.get(k) || { modelId: k, modelNumber: s.modelNumber, name: s.name, received: 0, remaining: 0, shop: 0, warehouse: 0, value: { USD: 0, SYP: 0 }, unpriced: 0, sold: 0, settled: 0 };
    for (const x of s.sizes) { row.sold += sold.get(`${s._id}|${x.size}`) || 0; row.settled += x.settledQty || 0; }
    if (s.kind === "received") row.received += s.sizes.reduce((n, x) => n + (x.initialQty || 0), 0);
    row.remaining += s.remaining;
    row[s.location] += s.remaining;
    if (s.agreedAmount == null) row.unpriced += s.remaining;
    else row.value[s.agreedCurrency] += s.remaining * toMinorC(s.agreedCurrency, s.agreedAmount);
    byModel.set(k, row);
  }
  const models = [...byModel.values()].map((r) => {
    const back = returned.get(r.modelId) || 0;
    return { ...r, value: { USD: fromMinorC("USD", r.value.USD), SYP: fromMinorC("SYP", r.value.SYP) }, returned: back, unsettled: Math.max(0, r.sold - r.settled), other: r.received - r.remaining - back - r.sold };
  }).sort((a, b) => a.modelNumber.localeCompare(b.modelNumber));

  let series = all.filter((s) => q.includeEmpty || s.remaining > 0);
  if (q.location) series = series.filter((s) => s.location === q.location);
  if (q.q && q.q.trim()) {
    const raw = q.q.trim();
    const mn = normalizeModelNumber(raw);
    const nk = normalizeText(raw);
    const sz = normalizeSize(raw);
    series = series.filter((s) =>
      s.seriesNo.startsWith(raw.toUpperCase()) || s.modelNumber.startsWith(mn) || normalizeText(s.name || "").includes(nk) || s.sizes.some((x) => x.size === sz && x.qty > 0));
  }
  const pieces = all.reduce((n, s) => n + s.remaining, 0);
  const unpricedPieces = all.filter((s) => s.agreedAmount == null).reduce((n, s) => n + s.remaining, 0);
  const val = (cur) => fromMinorC(cur, all.filter((s) => s.agreedCurrency === cur).reduce((n, s) => n + s.remaining * toMinorC(cur, s.agreedAmount), 0));
  return { summary: { pieces, unpricedPieces, value: { USD: val("USD"), SYP: val("SYP") } }, models, series: series.map(presentSeries) };
}

// ---------------------------------------------------------------- إرجاع بضاعة أمانة إلى التاجر
const presentReturn = (r, entry) => ({
  id: String(r._id),
  number: r.number,
  ref: r.ref,
  supplierId: String(r.supplier),
  items: r.items.map((i) => ({ seriesNo: i.seriesNo, modelNumber: i.modelNumber, name: i.name, size: i.size, qty: i.qty, location: i.location, agreedUnit: i.agreedUnit?.amount > 0 ? { amount: i.agreedUnit.amount, currency: i.agreedUnit.currency } : null })),
  totalQty: r.totalQty,
  value: { USD: r.value?.USD || 0, SYP: r.value?.SYP || 0 },
  unpricedQty: r.unpricedQty || 0,
  reason: r.reason,
  entryRef: entry?.ref || null,
  createdAt: r.createdAt,
  createdBy: r.createdBy?.name || "",
});

async function listReturns(supplierId) {
  await supplierService.requireSupplier(supplierId);
  return { items: (await returnRepo.listBySupplier(supplierId)).map((r) => presentReturn(r)) };
}

async function createReturn(supplierId, body, actor) {
  const supplier = await supplierService.requireSupplier(supplierId);

  // 1) تكرار الطلب: نفس المفتاح لا يُنفَّذ إلا مرة واحدة
  const prior = await returnRepo.findByKey(body.idempotencyKey);
  if (prior) {
    if (String(prior.supplier) !== String(supplier._id)) throw conflict("مفتاح الطلب مستخدم لعملية أخرى.", "IDEMPOTENCY_MISMATCH");
    if (prior.status === "applied") return { duplicate: true, return: presentReturn(prior) };
    throw conflict("هذا الإرجاع قيد المعالجة. لا تُعد الإرسال.", "RETURN_IN_PROGRESS");
  }

  // 2) دمج البنود المكررة (رتل، مقاس) والتحقق من الملكية والأهلية قبل أي تعديل
  const merged = new Map();
  for (const i of body.items) {
    const size = normalizeSize(i.size);
    const k = `${i.seriesId}|${size}`;
    merged.set(k, { seriesId: i.seriesId, size, qty: (merged.get(k)?.qty || 0) + i.qty });
  }
  const lines = [];
  const models = new Map();
  for (const it of merged.values()) {
    const s = await seriesRepo.findById(it.seriesId);
    if (!s) throw notFound("أحد الأرتال المحددة غير موجود.", "SERIES_NOT_FOUND");
    if (s.ownership !== "consignment" || String(s.supplier) !== String(supplier._id)) {
      throw conflict(`الرتل ${s.seriesNo} ليس بضاعة أمانة لهذا التاجر: لا يمكن إرجاعه إليه.`, "NOT_SUPPLIER_CONSIGNMENT");
    }
    const have = s.sizes.find((x) => x.size === it.size)?.qty || 0;
    if (have < it.qty) throw conflict(`المقاس ${it.size} في الرتل ${s.seriesNo}: المتوفر ${have} والمطلوب ${it.qty}.`, "INSUFFICIENT_STOCK");
    if (!models.has(String(s.model))) models.set(String(s.model), await productRepo.findById(s.model));
    const p = s.consignment?.price;
    const agreed = p?.amount > 0 ? { amount: p.amount, currency: p.currency } : undefined; // لا يُخمَّن من سعر الجملة الحالي ولا يُحوَّل
    lines.push({ series: s._id, seriesNo: s.seriesNo, model: s.model, modelNumber: s.modelNumber, name: s.name, size: it.size, qty: it.qty, agreedUnit: agreed, location: s.location });
  }
  const totalQty = lines.reduce((n, l) => n + l.qty, 0);
  const valueOf = (cur) => fromMinorC(cur, lines.filter((l) => l.agreedUnit?.currency === cur).reduce((n, l) => n + l.qty * toMinorC(cur, l.agreedUnit.amount), 0));
  const value = { USD: valueOf("USD"), SYP: valueOf("SYP") };
  const unpricedQty = lines.filter((l) => !l.agreedUnit).reduce((n, l) => n + l.qty, 0);

  // 3) السماح بقيد الدائن فقط لفاتورة صالحة تخص التاجر (التحقق قبل مطالبة المفتاح)
  if (body.credit?.invoiceId) await ledger.requireInvoice(supplier._id, body.credit.invoiceId);
  const money = body.credit ? ledger.toMoney(body.credit) : null;
  if (body.credit?.invoiceId && money) {
    // ائتمان على فاتورة: بعملتها نفسها، ولا يتجاوز المتبقي عليها (وإلا يُسجَّل كسلفة منفصلة)
    const { entries, allocations } = await ledger.loadState(supplier._id);
    const inv = await ledger.requireInvoice(supplier._id, body.credit.invoiceId);
    if (inv.currency !== money.currency) throw conflict("ائتمان الإرجاع يُربط بفاتورة بنفس عملته فقط.", "CROSS_CURRENCY_NOT_ALLOWED");
    const left = acct.invoiceStates([inv], allocations, entries).get(String(inv._id)).outstandingMinor;
    if (money.amountMinor > left) throw conflict("مبلغ الائتمان يتجاوز المتبقي على الفاتورة المحددة.", "INVOICE_OVERPAID");
  }

  // 4) مطالبة بالمفتاح ثم التنفيذ الذرّي
  const number = await nextSeq("supplierReturn");
  let claim;
  try {
    claim = await returnRepo.create({ number, ref: formatRef(number), supplier: supplier._id, idempotencyKey: body.idempotencyKey, items: lines, totalQty, value, unpricedQty, reason: body.reason, createdBy: actor ? { id: actor.id, name: actor.name } : undefined });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const again = await returnRepo.findByKey(body.idempotencyKey);
    if (again?.status === "applied" && String(again.supplier) === String(supplier._id)) return { duplicate: true, return: presentReturn(again) };
    throw conflict("هذا الإرجاع قيد المعالجة. لا تُعد الإرسال.", "RETURN_IN_PROGRESS");
  }

  try {
    const entry = await runAtomic(async (ctx) => {
      // خصم ذرّي مشروط من كل رتل (لا كمية سالبة حتى مع طلبات متزامنة)
      for (const l of lines) {
        const ok = await seriesRepo.decrement(l.series, l.size, l.qty, ctx);
        if (!ok) throw conflict(`المقاس ${l.size} في الرتل ${l.seriesNo} لم يعد متوفراً بالكمية المطلوبة (طلب متزامن؟).`, "INSUFFICIENT_STOCK");
        ctx.undo(() => seriesRepo.increment(l.series, l.size, l.qty, null));
      }

      // حركة مخزون مخصصة لكل (موديل، مقاس، موقع) مع قبل/بعد متسلسلين
      const groups = new Map();
      for (const l of lines) {
        const gk = `${l.model}|${l.size}`;
        const g = groups.get(gk) || { model: l.model, size: l.size, byLoc: new Map() };
        const cur = g.byLoc.get(l.location) || { qty: 0, allocations: [] };
        cur.qty += l.qty;
        cur.allocations.push({ series: l.series, seriesNo: l.seriesNo, qty: l.qty, location: l.location });
        g.byLoc.set(l.location, cur);
        groups.set(gk, g);
      }
      const rows = [];
      for (const g of groups.values()) {
        const { model, size } = await availability.hydratedSize(models.get(String(g.model)), g.size, ctx);
        const total = { shopDelta: 0, warehouseDelta: 0 };
        for (const [loc, v] of g.byLoc) total[dk(loc)] -= v.qty;
        let state = movementService.beforeOf(size, total); // الكمية قبل الإرجاع كله
        for (const [loc, v] of g.byLoc) {
          const before = { ...state };
          state = { ...state, [loc]: state[loc] - v.qty };
          rows.push(movementService.buildRow({
            model, size, type: "supplier_return", qty: v.qty, delta: -v.qty, from: loc, before, after: { ...state },
            costUsd: 0, reason: body.reason, ref: claim.ref, batchId: String(claim._id), allocations: v.allocations,
          }));
        }
      }
      await movementService.record(rows, ctx);

      // قيد مالي مرتبط (اختياري ومنفصل عن حركة المخزون): فقط حين يطلبه المالك
      if (!money) return null;
      const credit = await ledger.postEntry(
        {
          supplier: supplier._id, type: "return_credit", ...money, date: new Date(), invoice: body.credit.invoiceId, supplierReturn: claim._id,
          idempotencyKey: `srt:${body.idempotencyKey}`, note: body.credit.note || `ائتمان إرجاع بضاعة ${claim.ref}`, createdBy: actor ? { id: actor.id, name: actor.name } : undefined,
        },
        ctx
      );
      if (body.credit.invoiceId) await ledger.postAllocation({ supplier: supplier._id, entry: credit, invoice: await ledger.requireInvoice(supplier._id, body.credit.invoiceId, ctx), amountMinor: money.amountMinor, creditMinor: money.amountMinor, source: "direct", actor }, ctx);
      return credit;
    });
    await returnRepo.markApplied(claim._id, entry?._id);
    return { duplicate: false, return: presentReturn({ ...claim, status: "applied" }, entry), entry: entry ? ledger.presentEntry(entry) : null };
  } catch (err) {
    await returnRepo.deleteById(claim._id); // يسمح بإعادة المحاولة بنفس المفتاح بعد فشل حقيقي
    throw err;
  }
}

module.exports = { consignment, listReturns, createReturn };
