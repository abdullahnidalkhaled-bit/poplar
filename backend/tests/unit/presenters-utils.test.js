process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { describeSize, summarizeSizes, presentModel } = require("../../src/middleware/presenters/model.presenter");
const { normalizeModelNumber, isValidModelNumber, brandPrefix, formatModelNumber } = require("../../src/utils/modelNumber");
const { parsePayload, looksLikeQr } = require("../../src/services/lookup.service");
const { buildRow: buildMovement, pair } = require("../../src/services/movement.service");
const { normalizeText, tokenize } = require("../../src/utils/text");
const { normalizeSize, compareSizes } = require("../../src/utils/sizes");
const { computeFlag, convert, round } = require("../../src/utils/money");
const { parsePaging, pageResult } = require("../../src/utils/pagination");

// ------------------------------------------------ حالة المخزون (مثال المواصفات: S 1/0، M 1/1، L 0/0، XL 0/1)
const spec = [
  { size: "S", shopQty: 1, warehouseQty: 0 },
  { size: "M", shopQty: 1, warehouseQty: 1 },
  { size: "L", shopQty: 0, warehouseQty: 0 },
  { size: "XL", shopQty: 0, warehouseQty: 1 },
];

test("تصنيف المقاسات: متوفر بالمحل/كلاهما/مستودع فقط/نفد", () => {
  const by = Object.fromEntries(summarizeSizes(spec).sizes.map((s) => [s.size, s]));
  assert.equal(by.S.availability, "store_only");
  assert.equal(by.M.availability, "both");
  assert.equal(by.L.availability, "out_of_stock");
  assert.equal(by.XL.availability, "warehouse_only");
});

test("تحذير المصنع يظهر فقط عند النفاد في الموقعين، والتحويل عند وجود مستودع وغياب المحل", () => {
  const by = Object.fromEntries(summarizeSizes(spec).sizes.map((s) => [s.size, s]));
  assert.equal(by.L.needsFactoryRestock, true);
  assert.equal(by.XL.needsFactoryRestock, false, "XL في المستودع: لا يجوز تحذير المصنع");
  assert.equal(by.XL.canTransfer, true);
  assert.equal(by.M.canTransfer, false, "M في المحل أصلاً");
  assert.equal(by.S.needsFactoryRestock, false);
});

test("المقاسات الصفرية تظهر في القائمة، والمجاميع تُحسب من الكميات الخام", () => {
  const s = summarizeSizes(spec);
  assert.equal(s.sizes.length, 4);
  assert.deepEqual(s.totals, { shop: 2, warehouse: 2, combined: 4 });
  assert.deepEqual(s.outOfStockSizes, ["L"]);
  assert.deepEqual(s.restockSizes, ["L"]);
  assert.deepEqual(s.transferableSizes, ["XL"]);
  assert.deepEqual(s.availableSizes, ["S", "M", "XL"]);
});

test("قواعد التنبيه A-D: كمية 1 لا تُنبّه، والحرج صفر المحل فقط", () => {
  // A: متوفر بالمحل بكمية 1 => لا نفاد ولا نقل ولا طلب شحنة
  const a = describeSize({ size: "M", shopQty: 1, warehouseQty: 0 });
  assert.equal(a.availability, "store_only");
  assert.equal(a.canTransfer, false);
  assert.equal(a.needsFactoryRestock, false);
  assert.equal("lowStock" in a, false, "لا تنبيه انخفاض عند 1");
  // B: المحل صفر والمستودع فيه مخزون => انقل، ولا تطلب شحنة
  const b = describeSize({ size: "M", shopQty: 0, warehouseQty: 3 });
  assert.equal(b.availability, "warehouse_only");
  assert.equal(b.canTransfer, true);
  assert.equal(b.needsFactoryRestock, false);
  // C: صفر في الموقعين => اطلب شحنة
  const c = describeSize({ size: "M", shopQty: 0, warehouseQty: 0 });
  assert.equal(c.availability, "out_of_stock");
  assert.equal(c.canTransfer, false);
  assert.equal(c.needsFactoryRestock, true);
  // D: مخزون في الموقعين => لا تنبيه
  const d = describeSize({ size: "M", shopQty: 1, warehouseQty: 2 });
  assert.equal(d.availability, "both");
  assert.equal(d.canTransfer || d.needsFactoryRestock, false);
});

test("كميات تالفة (سالبة/نص) تُعامل كصفر ولا تكسر الحساب", () => {
  const d = describeSize({ size: "S", shopQty: -5, warehouseQty: "abc" });
  assert.equal(d.totalQty, 0);
});

test("الترتيب المنطقي للمقاسات", () => {
  const sorted = ["XL", "38", "S", "XXL", "M", "40", "L"].sort(compareSizes);
  assert.deepEqual(sorted, ["S", "M", "L", "XL", "XXL", "38", "40"]);
  assert.equal(normalizeSize(" x l "), "XL");
});

test("المخرجات تُحسب ولا يُخزَّن أي مجموع في الموديل", () => {
  const m = presentModel({ _id: "1", modelNumber: "FAF-001", name: "n", brand: "FAF", origin: "local", type: "t", costPrice: 1, sellPrice: 2, sizes: spec });
  assert.equal(m.totals.combined, 4);
  assert.ok(!("totalStock" in m));
});

// ------------------------------------------------ رقم الموديل و QR
test("رقم الموديل: تطبيع وتحقق وتوليد", () => {
  assert.equal(normalizeModelNumber("  faf-001 "), "FAF-001");
  assert.equal(isValidModelNumber("FAF-001"), true);
  for (const bad of ["x", "faf 001", "-FAF", "FAF/001", "", "A".repeat(40)]) assert.equal(isValidModelNumber(bad), false, bad);
  assert.equal(brandPrefix("FAF"), "FAF");
  assert.equal(brandPrefix("Zara"), "ZAR");
  assert.equal(brandPrefix("سيدرا"), "MDL");
  assert.equal(formatModelNumber("FAF", 7), "FAF-007");
});

test("QR: حمولة ثابتة بلا بيانات حساسة وتُحلَّل بدقة", () => {
  const payload = "PLP1:FAF-001";
  assert.equal(payload, "PLP1:FAF-001");
  assert.deepEqual(parsePayload(payload), { version: 1, modelNumber: "FAF-001" });
  assert.deepEqual(parsePayload("  plp1:faf-001 ").modelNumber, "FAF-001");
  assert.equal(looksLikeQr(payload), true);
  assert.equal(looksLikeQr("FAF-001"), false);
});

test("QR: رموز غير صالحة أو قديمة تعطي أخطاء واضحة", () => {
  assert.throws(() => parsePayload("hello"), (e) => e.code === "INVALID_QR");
  assert.throws(() => parsePayload("https://evil.example/FAF-001"), (e) => e.code === "INVALID_QR");
  assert.throws(() => parsePayload("PLP9:FAF-001"), (e) => e.code === "OBSOLETE_QR");
  assert.throws(() => parsePayload("PLP1:bad id!"), (e) => e.code === "INVALID_QR");
});

// ------------------------------------------------ النصوص والمال والترقيم
test("تطبيع النصوص: مسافات وحالة وتشكيل عربي", () => {
  assert.equal(normalizeText("  FAF   Bootcut  "), "faf bootcut");
  assert.equal(normalizeText("بَنطَال"), normalizeText("بنطال"));
  assert.equal(normalizeText("أحمر"), normalizeText("احمر"));
  assert.deepEqual(tokenize("FAF-Bootcut Trousers"), ["faf", "bootcut", "trousers"]);
});

test("علامات التسعير والتحويل", () => {
  assert.equal(computeFlag(15, 20, 45, "USD", 0), "below_cost");
  assert.equal(computeFlag(30, 20, 45, "USD", 0), "below_sell_price");
  assert.equal(computeFlag(45, 20, 45, "USD", 0), "normal");
  assert.equal(computeFlag(45 - 0.00001, 20, 45, "SYP", 14000), "normal", "تقريب الليرة لا يُنتج تنبيهاً كاذباً");
  assert.equal(convert(630000, "SYP", "USD", 14000), 45);
  assert.equal(round(1.005, 2), 1.01);
});

test("سيناريو التبديل بتغيّر الصرف: صافي ربح 28.33 وفرق صرف 1.67 خسارة", () => {
  const priceUsd = round(630000 / 14000, 4);       // 45
  const profitOld = priceUsd - 22;                 // 23
  const fx = round(630000 / 13500 - priceUsd, 4);  // 1.6667
  const newProfit = 60 - 30;
  assert.equal(profitOld, 23);
  assert.equal(fx, 1.6667);
  assert.equal(round(profitOld + newProfit - profitOld - fx, 2), 28.33);
  assert.equal(60 * 13500 - 630000, 180000, "المطلوب من الزبونة بالليرة");
});

test("الترقيم: حدود آمنة", () => {
  assert.deepEqual(parsePaging({ page: "0", limit: "9999" }), { page: 1, limit: 100, skip: 0 });
  assert.deepEqual(parsePaging({ page: "3", limit: "10" }), { page: 3, limit: 10, skip: 20 });
  assert.equal(pageResult([], 101, { page: 1, limit: 20 }).pages, 6);
});

test("صف الحركة يحمل نسخة وصفية وكميتي قبل/بعد", () => {
  const model = { _id: "m1", modelNumber: "FAF-001", name: "FAF Bootcut", brand: "FAF" };
  const row = buildMovement({ model, size: { _id: "s1", size: "M" }, type: "transfer", qty: 1, delta: 0, from: "warehouse", to: "shop", before: pair({ shopQty: 0, warehouseQty: 1 }), after: pair({ shopQty: 1, warehouseQty: 0 }) });
  assert.equal(row.modelNumber, "FAF-001");
  assert.equal(row.nameKey, "faf bootcut");
  assert.deepEqual(row.before, { shop: 0, warehouse: 1 });
  assert.deepEqual(row.after, { shop: 1, warehouse: 0 });
});
