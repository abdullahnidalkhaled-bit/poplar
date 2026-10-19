process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeItems } = require("../../src/services/stock.service");
const { beforeOf } = require("../../src/services/movement.service");
const repo = require("../../src/repositories/productModel.repository");
const { planMigration } = require("../../scripts/lib/plan");

test("دمج بنود المقاس المكرر في الشحنة", () => {
  assert.deepEqual(mergeItems([{ size: "m", qty: 1 }, { size: "M", qty: 2 }, { size: "S", qty: 1 }]), [{ size: "M", qty: 3 }, { size: "S", qty: 1 }]);
});

test("الكمية قبل التغيير = بعده - التغيير (موثوقة)", () => {
  assert.deepEqual(beforeOf({ shopQty: 1, warehouseQty: 0 }, { shopDelta: 1, warehouseDelta: -1 }), { shop: 0, warehouse: 1 });
});

test("فلتر الموديلات: حقول بسيطة وids فقط (قواعد التوفر ليست هنا)", () => {
  assert.deepEqual(repo.buildFilter({ brand: "FAF", includeInactive: true }), { brand: "FAF" });
  assert.deepEqual(repo.buildFilter({ ids: [1, 2] }), { active: true, _id: { $in: [1, 2] } });
});

// ------------------------------------------------ خطة الترحيل
const legacy = [
  {
    _id: "p1", name: "بنطال جينز", brand: "FAF", origin: "local", category: "بناطيل", costPrice: 20, sellPrice: 45, createdAt: "2026-01-01",
    variants: [
      { _id: "v1", style: "بوت كات", color: "أسود", size: "S", barcode: "111", shopQty: 1, warehouseQty: 0 },
      { _id: "v2", style: "بوت كات", color: "أسود", size: "m", barcode: "112", shopQty: 1, warehouseQty: 1 },
      { _id: "v3", style: "سكيني", color: "أسود", size: "S", barcode: "113", shopQty: 2, warehouseQty: 0 },
      { _id: "v4", style: "بوت كات", color: "أزرق", size: "S", barcode: "114", shopQty: 0, warehouseQty: 5 },
    ],
  },
  { _id: "p2", name: "فستان", brand: "سيدرا", origin: "local", category: "فساتين", costPrice: 22, sellPrice: 40, createdAt: "2026-02-01", variants: [{ _id: "v5", color: "", size: "وسط", barcode: "200", shopQty: 3, warehouseQty: 0 }] },
];

test("الترحيل: كل (قَصّة + لون) موديل مستقل برقم فريد، والكميات والباركود محفوظة", () => {
  const { models, warnings } = planMigration(legacy);
  assert.equal(models.length, 4);
  const numbers = models.map((m) => m.doc.modelNumber);
  assert.equal(new Set(numbers).size, 4, "أرقام الموديلات فريدة");
  assert.deepEqual(numbers.slice(0, 3), ["FAF-001", "FAF-002", "FAF-003"]);
  const black = models.find((m) => m.doc.cut === "بوت كات" && m.doc.legacy.color === "أسود").doc;
  assert.deepEqual(black.sizes.map((s) => [s.size, s.shopQty, s.warehouseQty, s.barcode]), [["S", 1, 0, "111"], ["M", 1, 1, "112"]]);
  assert.equal(black.notes, "اللون السابق: أسود", "اللون لا يضيع");
  const total = models.flatMap((m) => m.doc.sizes).reduce((s, z) => s + z.shopQty + z.warehouseQty, 0);
  assert.equal(total, 1 + 2 + 2 + 5 + 3, "مجموع المخزون قبل = بعد");
  assert.ok(warnings.some((w) => w.includes("وسط")), "مقاس غير صالح يُبلَّغ عنه");
});

test("الترحيل idempotent: ما رُحِّل سابقاً يُتخطّى ولا تتكرر الأرقام", () => {
  const first = planMigration(legacy);
  const migratedKeys = new Set(first.models.map((m) => m.legacyKey));
  const again = planMigration(legacy, { migratedKeys, existingModelNumbers: new Set(first.models.map((m) => m.doc.modelNumber)), counters: first.counters });
  assert.equal(again.models.length, 0);
});

test("الترحيل يتخطّى أرقاماً مستخدمة يدوياً", () => {
  const { models } = planMigration(legacy.slice(0, 1), { existingModelNumbers: new Set(["FAF-001"]) });
  assert.ok(!models.some((m) => m.doc.modelNumber === "FAF-001"));
});
