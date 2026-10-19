// منطق ترحيل خالص (بلا قاعدة بيانات): يحوّل منتجات النسخة السابقة إلى موديلات جديدة.
//
// القاعدة: في النسخة الجديدة رقم الموديل يحدد اللون والقَصّة، لذلك كل (قَصّة + لون) في المنتج القديم
// يصبح موديلاً مستقلاً برقم خاص. اللون القديم لا يضيع: يُحفظ في notes وفي legacy.color.
const { SIZE_REGEX } = require("../../src/config/constants");
const { brandPrefix, formatModelNumber } = require("../../src/utils/modelNumber");
const { normalizeSize } = require("../../src/utils/sizes");

const groupKey = (productId, style, color) => `${productId}|${style || ""}|${color || ""}`;

function sanitizeSize(raw, index, warnings, label) {
  const s = normalizeSize(raw);
  if (SIZE_REGEX.test(s)) return s;
  const cleaned = s.replace(/[^A-Z0-9./-]/g, "").slice(0, 10);
  const fixed = SIZE_REGEX.test(cleaned) ? cleaned : `SZ${index + 1}`;
  warnings.push(`${label}: المقاس "${raw}" غير صالح، حُوّل إلى "${fixed}"`);
  return fixed;
}

function planMigration(legacyProducts, { existingModelNumbers = new Set(), counters = {}, migratedKeys = new Set() } = {}) {
  const warnings = [];
  const taken = new Set(existingModelNumbers);
  const seqs = { ...counters };
  const allocate = (prefix) => {
    let seq = seqs[prefix] || 0;
    let candidate;
    do candidate = formatModelNumber(prefix, ++seq);
    while (taken.has(candidate));
    seqs[prefix] = seq;
    taken.add(candidate);
    return candidate;
  };

  const models = [];
  const sorted = [...legacyProducts].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  for (const p of sorted) {
    const groups = new Map();
    for (const v of p.variants || []) {
      const key = groupKey(p._id, v.style, v.color);
      if (!groups.has(key)) groups.set(key, { style: v.style || "", color: v.color || "", variants: [] });
      groups.get(key).variants.push(v);
    }
    if (!groups.size) warnings.push(`المنتج "${p.name}" بلا متغيّرات: تخطّيناه`);

    for (const [key, g] of groups) {
      if (migratedKeys.has(key)) continue; // رُحِّل سابقاً
      const label = `${p.brand} ${p.name}`;
      const sizes = new Map();
      g.variants.forEach((v, i) => {
        const size = sanitizeSize(v.size, i, warnings, label);
        const prev = sizes.get(size);
        if (prev) {
          prev.shopQty += v.shopQty || 0;
          prev.warehouseQty += v.warehouseQty || 0;
          warnings.push(`${label}: المقاس ${size} مكرر داخل نفس المجموعة فجُمعت كمياته`);
        } else {
          sizes.set(size, { size, shopQty: v.shopQty || 0, warehouseQty: v.warehouseQty || 0, barcode: v.barcode, legacyVariantId: v._id });
        }
      });
      models.push({
        legacyKey: key,
        doc: {
          modelNumber: allocate(brandPrefix(p.brand)),
          name: p.name, brand: p.brand, origin: p.origin, type: p.category || "غير محدد",
          cut: g.style, season: p.season || "",
          notes: g.color ? `اللون السابق: ${g.color}` : "",
          costPrice: p.costPrice, sellPrice: p.sellPrice,
          sizes: [...sizes.values()],
          legacy: { productId: p._id, color: g.color, style: g.style },
          createdAt: p.createdAt,
        },
      });
    }
  }
  return { models, warnings, counters: seqs };
}

module.exports = { planMigration, groupKey };
