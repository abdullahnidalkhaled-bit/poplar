const seriesRepo = require("../repositories/series.repository");
const productRepo = require("../repositories/productModel.repository");
const { isOut, canTransfer } = require("../utils/stock");

/**
 * المصدر الوحيد لتوفر المخزون: يجمّع كميات كل الأرتال لكل (موديل، مقاس، موقع).
 * قاعدة التنبيه نفسها في utils/stock.js؛ والحقول المشتقة للعرض يحسبها عارض النموذج في middleware/presenters.
 */

const toPlain = (doc) => (typeof doc.toObject === "function" ? doc.toObject() : doc);

function hydrateWith(doc, map) {
  const m = toPlain(doc);
  const per = map.get(String(m._id)) || new Map();
  return {
    ...m,
    sizes: (m.sizes || []).map((s) => ({
      ...s,
      shopQty: per.get(s.size)?.shop || 0,
      warehouseQty: per.get(s.size)?.warehouse || 0,
    })),
  };
}

// يملأ shopQty/warehouseQty لكل مقاس من الأرتال (استعلام تجميع واحد لكل الدفعة)
async function hydrateMany(docs, ctx) {
  if (!docs.length) return [];
  const map = await seriesRepo.sumBySize(docs.map((d) => d._id), ctx);
  return docs.map((d) => hydrateWith(d, map));
}
const hydrate = async (doc, ctx) => (await hydrateMany([doc], ctx))[0];

// الموديل بعد العملية مع مقاس واحد بكمياته المجمّعة (يستعمله تسجيل الحركات)
async function hydratedSize(modelDoc, size, ctx) {
  const model = await hydrate(modelDoc, ctx);
  return { model, size: model.sizes.find((s) => s.size === size) };
}

// كمية مقاس واحد في الموقعين
async function sizeQty(modelId, size, ctx) {
  const q = (await seriesRepo.sumBySize([modelId], ctx)).get(String(modelId))?.get(size);
  return { shop: q?.shop || 0, warehouse: q?.warehouse || 0 };
}

// مجموع قطع موديل في كل المواقع
async function modelTotal(modelId, ctx) {
  const per = (await seriesRepo.sumBySize([modelId], ctx)).get(String(modelId));
  let n = 0;
  if (per) for (const q of per.values()) n += q.shop + q.warehouse;
  return n;
}

const qtyOf = (per, size) => ({ shop: per?.get(size)?.shop || 0, warehouse: per?.get(size)?.warehouse || 0 });

// الموديلات النشطة التي فيها مقاس واحد على الأقل بحالة معيّنة: out (صفر في الموقعين) أو transfer (صفر بالمحل ومتوفر بالمستودع)
async function modelIdsByStatus(status) {
  const [models, map] = await Promise.all([productRepo.findActiveSizes(), seriesRepo.sumBySize(null)]);
  const test = status === "out" ? isOut : canTransfer;
  return models
    .filter((m) => {
      const per = map.get(String(m._id));
      return m.sizes.some((s) => {
        const q = qtyOf(per, s.size);
        return test(q.shop, q.warehouse);
      });
    })
    .map((m) => m._id);
}

// لوحة المخزون: المجاميع وقيمها + المقاسات التي تحتاج انتباهاً (تحويل أو توريد)
async function inventoryOverview() {
  const [models, map] = await Promise.all([productRepo.findActiveOverview(), seriesRepo.sumBySize(null)]);
  const totals = { models: models.length, sizes: 0, shop: 0, warehouse: 0, costValueUsd: 0, sellValueUsd: 0 };
  const attention = [];
  for (const m of models) {
    const per = map.get(String(m._id));
    const rows = m.sizes.map((s) => ({ size: s.size, ...qtyOf(per, s.size) }));
    totals.sizes += rows.length;
    for (const r of rows) {
      totals.shop += r.shop;
      totals.warehouse += r.warehouse;
      totals.costValueUsd += m.costPrice * (r.shop + r.warehouse);
      totals.sellValueUsd += m.sellPrice * (r.shop + r.warehouse);
    }
    const restockSizes = rows.filter((r) => isOut(r.shop, r.warehouse)).map((r) => r.size);
    const transferSizes = rows.filter((r) => canTransfer(r.shop, r.warehouse)).map((r) => ({ size: r.size, warehouseQty: r.warehouse }));
    if (restockSizes.length || transferSizes.length) attention.push({ modelNumber: m.modelNumber, name: m.name, brand: m.brand, restockSizes, transferSizes });
  }
  totals.combined = totals.shop + totals.warehouse;
  return { totals, attention: attention.slice(0, 200) };
}

module.exports = { hydrate, hydrateMany, hydratedSize, sizeQty, modelTotal, modelIdsByStatus, inventoryOverview };
