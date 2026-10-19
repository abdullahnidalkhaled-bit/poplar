// تخطيط ترحيل الكميات القديمة (sizes[].shopQty/warehouseQty) إلى أرتال. دوال خالصة بلا قاعدة بيانات.
// القاعدة: لا نخترع تجميعات. القطع القديمة ليس لها عضوية رتل معروفة، لذلك كل (موديل، موقع) => رتل رصيد "balance" واحد
// يحمل الكميات الحالية كما هي، وهو معفى من قاعدة (1 أو 2) لأنها تخص الأرتال المستلمة فقط.
const LOCATIONS = [["shop", "shopQty"], ["warehouse", "warehouseQty"]];

const toQty = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0);

/** sizes: [{ size, shopQty, warehouseQty }] => [{ location, sizes: [{ size, qty }] }] (المواقع الفارغة تُحذف) */
function planBalanceSeries(sizes) {
  const out = [];
  for (const [location, field] of LOCATIONS) {
    const rows = (sizes || []).map((s) => ({ size: s.size, qty: toQty(s[field]) })).filter((s) => s.qty > 0);
    if (rows.length) out.push({ location, sizes: rows });
  }
  return out;
}

/**
 * models: مستندات product_models الخام. migratedKeys: Set بمفاتيح "<modelId>:<location>" المرحَّلة سابقاً.
 * تعيد الخطة + إجمالي الكميات القديمة لتتحقق منه بعد التنفيذ (لا نقص ولا تكرار).
 */
function planSeriesMigration(models, { migratedKeys = new Set() } = {}) {
  const items = [];
  const warnings = [];
  const expected = new Map(); // modelId -> إجمالي القطع القديمة (للتحقق)
  for (const m of models) {
    const legacySizes = (m.sizes || []).filter((s) => s.shopQty !== undefined || s.warehouseQty !== undefined);
    for (const s of legacySizes) {
      for (const [, field] of LOCATIONS) {
        if (s[field] !== undefined && (!Number.isInteger(s[field]) || s[field] < 0)) warnings.push(`${m.modelNumber} ${s.size}: كمية غير صالحة (${s[field]}) تُعامل كـ ${toQty(s[field])}`);
      }
    }
    for (const plan of planBalanceSeries(legacySizes)) {
      const key = `${m._id}:${plan.location}`;
      if (migratedKeys.has(key)) continue;
      items.push({ key, modelId: m._id, modelNumber: m.modelNumber, location: plan.location, sizes: plan.sizes, receivedAt: m.createdAt });
      expected.set(String(m._id), (expected.get(String(m._id)) || 0) + plan.sizes.reduce((n, x) => n + x.qty, 0));
    }
  }
  return { items, warnings, expected, totalPieces: [...expected.values()].reduce((a, b) => a + b, 0) };
}

module.exports = { planBalanceSeries, planSeriesMigration, toQty };
