const repo = require("../repositories/series.repository");
const movementRepo = require("../repositories/movement.repository");
const { nextSeq } = require("../repositories/counter.repository");
const { validateSeriesComposition, formatSeriesNo, totalOf, summarizeSizesText } = require("../utils/series");
const { normalizeSize } = require("../utils/sizes");
const { normalizeText, escapeRegex } = require("../utils/text");
const { normalizeModelNumber } = require("../utils/modelNumber");
const { parsePaging, pageResult } = require("../utils/pagination");
const { badRequest, notFound, conflict } = require("../utils/errors");

const MAX_ATTEMPTS = 5;

const snapshot = (model) => ({
  model: model._id, modelNumber: model.modelNumber, name: model.name, nameKey: normalizeText(model.name), type: model.type, cut: model.cut,
});

const allocationOf = (s, qty, location) => ({ series: s._id, seriesNo: s.seriesNo, qty, location });

// ---------------------------------------------------------------- إنشاء
/** رتل مستلم: يخضع لقاعدة (1 أو 2) لكل مقاس. التحقق هنا هو خط الدفاع الأخير حتى لو تجاوز الطلب الـ validator */
async function createReceived(model, { location, sizes, shipmentRef, note = "", receivedAt, supplier, ownership, consignmentPrice }, ctx) {
  const normalized = sizes.map((s) => ({ size: normalizeSize(s.size), qty: s.qty }));
  const errors = validateSeriesComposition(normalized);
  if (errors.length) throw badRequest(errors[0], "INVALID_SERIES", errors);
  const doc = await repo.create(
    {
      ...snapshot(model),
      seriesNo: formatSeriesNo(await nextSeq("series", ctx)),
      location, kind: "received", shipmentRef, note,
      ...(supplier ? { supplier, ownership: ownership || "owned" } : {}),
      ...(ownership === "consignment" && consignmentPrice ? { consignment: { price: consignmentPrice, history: [{ kind: "set", at: new Date(), reason: "سعر الاتفاق عند الاستلام", price: consignmentPrice }] } } : {}),
      receivedAt: receivedAt || new Date(),
      sizes: normalized.map((s) => ({ size: s.size, initialQty: s.qty, qty: s.qty })),
    },
    ctx
  );
  ctx.undo(() => repo.deleteById(doc._id));
  return doc;
}

// رتل الرصيد (قديم مُرحَّل / زيادات الجرد): واحد لكل (موديل، موقع)
async function ensureBalance(model, location, ctx) {
  let doc = await repo.findBalance(model._id, location, ctx);
  if (doc) return doc;
  try {
    doc = await repo.create(
      { ...snapshot(model), seriesNo: formatSeriesNo(await nextSeq("series", ctx)), location, kind: "balance", status: "depleted", sizes: [], receivedAt: new Date(0) },
      ctx
    );
    ctx.undo(() => repo.deleteById(doc._id));
    return doc;
  } catch (err) {
    if (err.code === 11000) return repo.findBalance(model._id, location, ctx); // سباق: أنشأه طلب آخر
    throw err;
  }
}

// رتل مشتق في الوجهة لنفس الأصل الجذري: تُدمج فيه النقلات المتتالية
async function ensureDerived(source, location, ctx) {
  const rootId = source.originSeries || source._id;
  let doc = await repo.findDerived(rootId, location, ctx);
  if (doc) return doc;
  try {
    doc = await repo.create(
      {
        model: source.model, modelNumber: source.modelNumber, name: source.name, nameKey: source.nameKey, type: source.type, cut: source.cut,
        seriesNo: formatSeriesNo(await nextSeq("series", ctx)),
        location, kind: "derived", originSeries: rootId, status: "depleted", sizes: [],
        // الملكية وسعر الاتفاق ينتقلان مع القطع المنقولة (وإلا صارت الأمانة المنقولة بلا سعر فلا تُسوّى ولا تُقيَّم)
        ...(source.supplier ? { supplier: source.supplier, ownership: source.ownership } : {}),
        ...(source.supplier && source.consignment?.price?.amount > 0
          ? { consignment: { price: source.consignment.price, history: [{ kind: "set", at: new Date(), reason: "موروث من الرتل الأصل عند النقل", price: source.consignment.price }] } }
          : {}),
        receivedAt: source.receivedAt, // العمر الأصلي يحدد ترتيب FIFO
      },
      ctx
    );
    ctx.undo(() => repo.deleteById(doc._id));
    return doc;
  } catch (err) {
    if (err.code === 11000) return repo.findDerived(rootId, location, ctx);
    throw err;
  }
}

// ---------------------------------------------------------------- خصم FIFO
/**
 * يخصم qty من مقاس في موقع عبر الأرتال الأقدم فالأحدث، ويعيد التوزيع [{series, seriesNo, qty, location, source}].
 * كل خصم ذرّي مشروط؛ عند تعارض متزامن يُعاد التخطيط (حتى 5 مرات). لا يمكن أن تصبح كمية سالبة.
 */
async function consume({ modelNumber, modelId, size, location, qty }, ctx) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidates = await repo.findFifo(modelId, location, size, ctx);
    let need = qty;
    const plan = [];
    for (const s of candidates) {
      if (need <= 0) break;
      const have = s.sizes.find((x) => x.size === size)?.qty || 0;
      const take = Math.min(have, need);
      if (take > 0) { plan.push({ s, take }); need -= take; }
    }
    if (need > 0) {
      const available = qty - need;
      const where = location === "shop" ? "المحل" : "المستودع";
      throw conflict(`كمية ${where} من المقاس ${size} (${modelNumber}) غير كافية (المتوفر ${available}، المطلوب ${qty}).`, "INSUFFICIENT_STOCK");
    }

    const done = [];
    let failed = false;
    for (const { s, take } of plan) {
      const ok = await repo.decrement(s._id, size, take, ctx);
      if (!ok) { failed = true; break; }
      done.push({ s, take });
    }
    if (failed) {
      for (const d of done) await repo.increment(d.s._id, size, d.take, ctx); // تراجع جزئي ثم إعادة التخطيط
      continue;
    }
    for (const d of done) ctx.undo(() => repo.increment(d.s._id, size, d.take, null));
    return done.map(({ s, take }) => ({ ...allocationOf(s, take, location), source: s }));
  }
  throw conflict("تعارض أثناء الحفظ بسبب تعديل متزامن. أعد المحاولة.", "CONFLICT");
}

// ---------------------------------------------------------------- إيداع
async function addTo(series, size, qty, ctx) {
  await repo.increment(series._id, size, qty, ctx);
  ctx.undo(() => repo.decrement(series._id, size, qty, null));
  return allocationOf(series, qty, series.location);
}

// نقل جزئي: كل تخصيص مصدر يذهب إلى رتل مشتق في الوجهة يحمل هوية الأصل
async function depositDerived(sourceAllocations, size, location, ctx) {
  const out = [];
  for (const a of sourceAllocations) {
    const target = await ensureDerived(a.source, location, ctx);
    out.push(await addTo(target, size, a.qty, ctx));
  }
  return out;
}

async function depositBalance(model, location, size, qty, ctx) {
  return addTo(await ensureBalance(model, location, ctx), size, qty, ctx);
}

/**
 * إعادة قطع إلى أرتالها الأصلية (إلغاء/إرجاع). allocations = من الفاتورة؛ بدونها (فواتير قديمة) يعود إلى رتل رصيد المحل.
 * ما زاد عن التوزيع المسجّل يذهب إلى رتل الرصيد.
 */
async function restore({ model, size, qty, allocations, location = "shop" }, ctx) {
  let left = qty;
  const out = [];
  for (const a of allocations || []) {
    if (left <= 0) break;
    const series = await repo.findById(a.series, ctx);
    if (!series) continue;
    const n = Math.min(left, a.qty);
    out.push(await addTo(series, size, n, ctx));
    left -= n;
  }
  if (left > 0) out.push(await depositBalance(model, location, size, left, ctx));
  return out;
}

// ---------------------------------------------------------------- سجل الأرتال
const LIST_SORTS = { receivedAt: "receivedAt", createdAt: "createdAt", seriesNo: "seriesNo", modelNumber: "modelNumber" };

const present = (s) => ({
  id: String(s._id),
  seriesNo: s.seriesNo,
  modelId: String(s.model),
  modelNumber: s.modelNumber,
  name: s.name,
  type: s.type || "",
  cut: s.cut || "",
  location: s.location,
  kind: s.kind,
  status: s.status,
  originSeries: s.originSeries ? String(s.originSeries) : null,
  sizes: [...s.sizes].sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true })).map((x) => ({ size: x.size, initialQty: x.initialQty, qty: x.qty })),
  totalPieces: s.totalPieces ?? totalOf(s.sizes),
  sizeSummary: summarizeSizesText(s.sizes),
  receivedAt: s.receivedAt,
  createdAt: s.createdAt,
  shipmentRef: s.shipmentRef || "",
  ownership: s.ownership || "owned",
});

async function list(q) {
  const and = [{ $or: [{ kind: { $ne: "balance" } }, { "sizes.0": { $exists: true } }] }];
  if (q.location) and.push({ location: q.location });
  if (q.status) and.push({ status: q.status });
  if (q.ownership) and.push(q.ownership === "owned" ? { ownership: { $ne: "consignment" } } : { ownership: "consignment" });
  if (q.from && q.to) and.push({ receivedAt: { $gte: new Date(q.from), $lt: new Date(q.to) } });
  if (q.q && q.q.trim()) {
    const raw = q.q.trim();
    and.push({
      $or: [
        { seriesNo: new RegExp(`^${escapeRegex(raw.toUpperCase())}`) },
        { modelNumber: new RegExp(`^${escapeRegex(normalizeModelNumber(raw))}`) },
        { nameKey: new RegExp(escapeRegex(normalizeText(raw))) },
      ],
    });
  }
  const paging = parsePaging(q, 25);
  const field = LIST_SORTS[q.sort] || "receivedAt";
  const dir = q.dir === "asc" ? 1 : -1;
  const { items, total } = await repo.list({ $and: and }, { sort: { [field]: dir, _id: dir }, skip: paging.skip, limit: paging.limit });
  return pageResult(items.map(present), total, paging);
}

async function detail(seriesNo) {
  const s = await repo.findBySeriesNo(String(seriesNo).toUpperCase());
  if (!s) throw notFound(`الرتل ${seriesNo} غير موجود.`, "SERIES_NOT_FOUND");
  const [movements, origin, children] = await Promise.all([
    movementRepo.bySeries(s._id),
    s.originSeries ? repo.findById(s.originSeries) : null,
    repo.findChildren(s._id),
  ]);
  return {
    ...present(s),
    origin: origin ? { seriesNo: origin.seriesNo, location: origin.location } : null,
    derived: children.map((c) => ({ seriesNo: c.seriesNo, location: c.location })),
    movements: movements.map((m) => ({
      id: String(m._id), type: m.type, size: m.size, qty: m.qty, from: m.from, to: m.to, ref: m.ref, reason: m.reason, createdAt: m.createdAt,
      // الكمية التي مسّت هذا الرتل تحديداً
      seriesQty: m.allocations.filter((a) => String(a.series) === String(s._id)).reduce((n, a) => n + a.qty, 0),
    })),
  };
}

module.exports = { createReceived, ensureBalance, consume, depositDerived, depositBalance, restore, list, detail, present };
