const movementRepo = require("../repositories/movement.repository");
const { normalizeModelNumber } = require("../utils/modelNumber");
const { normalizeSize } = require("../utils/sizes");
const { normalizeText, escapeRegex } = require("../utils/text");
const { round } = require("../utils/money");
const { parsePaging, pageResult } = require("../utils/pagination");

const SORTS = { createdAt: "createdAt", type: "type", modelNumber: "modelNumber", qty: "qty" };

const pair = (s) => (s ? { shop: s.shopQty, warehouse: s.warehouseQty } : { shop: 0, warehouse: 0 });

// الكمية قبل التغيير = الكمية بعده - التغيير (موثوقة: كل كتابة ذرّية ثم نقرأ المجموع)
const beforeOf = (afterSize, change) => ({
  shop: afterSize.shopQty - (change.shopDelta || 0),
  warehouse: afterSize.warehouseQty - (change.warehouseDelta || 0),
});

// بناء صف سجل حركة موحّد (المصدر الوحيد لشكل السجل)
function buildRow({ model, size, type, qty, delta, from = null, to = null, before, after, costUsd = 0, reason = "", ref = "", batchId, allocations }) {
  return {
    type,
    model: model._id,
    sizeId: size._id,
    modelNumber: model.modelNumber,
    name: model.name,
    nameKey: normalizeText(model.name),
    brand: model.brand,
    size: size.size,
    qty,
    delta,
    from,
    to,
    before,
    after,
    costUsd: round(costUsd, 2),
    reason,
    ref,
    batchId,
    allocations,
  };
}

// عند الفشل لاحقاً في نفس الوحدة الذرّية (مسار standalone) تُحذف الحركات المُدرجة: لا حركات يتيمة تشير إلى أرتال مُلغاة
const record = async (rows, ctx) => {
  const docs = await movementRepo.insertMany(rows, ctx);
  if (ctx?.undo && docs.length) ctx.undo(() => movementRepo.deleteByIds(docs.map((d) => d._id)));
  return docs;
};

// سجل الحركات: بحث + فلاتر + ترتيب + ترقيم صفحات في القاعدة (لا تصفية على الواجهة)
async function list(q) {
  const and = [];
  if (q.type) and.push({ type: q.type });
  if (q.series) and.push({ "allocations.seriesNo": q.series.trim().toUpperCase() });
  if (q.size) and.push({ size: normalizeSize(q.size) });
  if (q.from && q.to) and.push({ createdAt: { $gte: new Date(q.from), $lt: new Date(q.to) } });
  if (q.location) and.push({ $or: [{ from: q.location }, { to: q.location }] });
  if (q.q && q.q.trim()) {
    const mn = escapeRegex(normalizeModelNumber(q.q));
    and.push({
      $or: [
        { modelNumber: new RegExp(`^${mn}`) },
        { nameKey: new RegExp(escapeRegex(normalizeText(q.q))) },
        { ref: new RegExp(`^${escapeRegex(q.q.trim())}`, "i") },
      ],
    });
  }
  const paging = parsePaging(q, 25);
  const sortField = SORTS[q.sort] || "createdAt";
  const dir = q.dir === "asc" ? 1 : -1;
  const { items, total } = await movementRepo.query(and.length ? { $and: and } : {}, {
    sort: { [sortField]: dir, _id: dir }, skip: paging.skip, limit: paging.limit,
  });
  return pageResult(items, total, paging);
}

module.exports = { pair, beforeOf, buildRow, record, list };
