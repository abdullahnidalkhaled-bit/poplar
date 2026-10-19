// عارض النموذج: يحوّل موديلاً خاماً (مقاساته تحمل shopQty/warehouseQty من الأرتال) إلى الاستجابة الموحّدة.
// كل الحقول المشتقة (availability، canTransfer، المجاميع...) تُحسب هنا فقط عند جاهزية الاستجابة.
const { compareSizes } = require("../../utils/sizes");
const { qty, isOut, canTransfer } = require("../../utils/stock");

function describeSize(s) {
  const shop = qty(s.shopQty);
  const warehouse = qty(s.warehouseQty);
  const total = shop + warehouse;

  let availability;
  if (shop > 0 && warehouse > 0) availability = "both";
  else if (shop > 0) availability = "store_only";
  else if (warehouse > 0) availability = "warehouse_only";
  else availability = "out_of_stock";

  return {
    id: s._id ? String(s._id) : undefined,
    size: s.size,
    barcode: s.barcode || "",
    shopQty: shop,
    warehouseQty: warehouse,
    totalQty: total,
    availability,
    canTransfer: canTransfer(shop, warehouse),      // المحل صفر والمستودع فيه: انقل
    needsFactoryRestock: isOut(shop, warehouse),     // صفر في الموقعين: اطلب شحنة
  };
}

function summarizeSizes(sizes) {
  const described = [...(sizes || [])].sort((a, b) => compareSizes(a.size, b.size)).map(describeSize);
  const totals = described.reduce((t, s) => ({ shop: t.shop + s.shopQty, warehouse: t.warehouse + s.warehouseQty }), { shop: 0, warehouse: 0 });
  const names = (pred) => described.filter(pred).map((s) => s.size);
  return {
    sizes: described,
    totals: { ...totals, combined: totals.shop + totals.warehouse },
    availableSizes: names((s) => s.totalQty > 0),
    outOfStockSizes: names((s) => s.totalQty === 0),
    transferableSizes: names((s) => s.canTransfer),
    restockSizes: names((s) => s.needsFactoryRestock),
  };
}

function presentModel(doc) {
  const m = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(m._id),
    modelNumber: m.modelNumber,
    name: m.name,
    brand: m.brand,
    origin: m.origin,
    type: m.type,
    cut: m.cut || "",
    season: m.season || "",
    notes: m.notes || "",
    costPrice: m.costPrice,
    sellPrice: m.sellPrice,
    active: m.active !== false,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    ...summarizeSizes(m.sizes),
  };
}

module.exports = { name: "model", present: presentModel, describeSize, summarizeSizes, presentModel };
