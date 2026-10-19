/*
 * ترحيل الكميات القديمة إلى أرتال، على MongoDB حقيقي (قاعدة اسمها يحوي test، تُفرَّغ).
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test_migration" npm run test:integration
 */
process.env.NODE_ENV = "test";
// قاعدة مستقلة لهذا الملف: node --test يشغّل الملفات بالتوازي ولا يجوز أن يفرّغ أحدها قاعدة الآخر
const withDbSuffix = (uri, suffix) => {
  if (!uri) return uri;
  const u = new URL(uri);
  u.pathname = `${u.pathname.replace(/\/$/, "") || "/poplar_test"}${suffix}`;
  return u.toString();
};
const URI = withDbSuffix(process.env.MONGO_TEST_URI, "_migration");
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const suite = (name, fn) => test(name, { skip }, fn);
const script = path.join(__dirname, "..", "..", "scripts", "migrate-series.js");
const run = (...args) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, MONGO_URI: URI }, encoding: "utf8" });

let mongoose, db;
test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  db = mongoose.connection.db;
  const Series = require("../../src/models/series.model");
  await Series.init();
  await db.collection("product_models").insertMany([
    {
      modelNumber: "OLD-100", name: "Old Jeans", brand: "Old", origin: "local", type: "بنطال", cut: "", costPrice: 20, sellPrice: 40, active: true, createdAt: new Date("2026-01-01"),
      sizes: [{ size: "S", shopQty: 3, warehouseQty: 0 }, { size: "M", shopQty: 5, warehouseQty: 7 }, { size: "L", shopQty: 0, warehouseQty: 0 }],
    },
    {
      modelNumber: "OLD-200", name: "Old Dress", brand: "Old", origin: "local", type: "فستان", cut: "", costPrice: 30, sellPrice: 60, active: true, createdAt: new Date("2026-02-01"),
      sizes: [{ size: "M", shopQty: 0, warehouseQty: 4 }],
    },
    { modelNumber: "NEW-300", name: "Fresh", brand: "New", origin: "local", type: "قميص", cut: "", costPrice: 10, sellPrice: 20, active: true, sizes: [{ size: "S" }] }, // بلا كميات قديمة
  ]);
});
test.after(async () => {
  if (skip) return;
  await mongoose.disconnect();
});

suite("التجربة الجافة لا تكتب شيئاً", async () => {
  const out = run();
  assert.match(out, /لم يُكتب شيء/);
  assert.equal(await db.collection("series").countDocuments(), 0);
});

suite("التنفيذ: رتل رصيد لكل (موديل، موقع) والإجماليات مطابقة تماماً، والحقول القديمة لم تُمسّ", async () => {
  const out = run("--apply");
  assert.match(out, /التحقق ناجح/);
  const series = await db.collection("series").find({}).toArray();
  assert.equal(series.length, 3, "OLD-100 محل+مستودع، OLD-200 مستودع، ولا شيء لـ NEW-300 (ولا لموقع فارغ)");
  assert.ok(series.every((s) => s.kind === "balance" && s.shipmentRef === "MIGRATION"));
  const sum = (loc, mn) => series.filter((s) => s.location === loc && s.modelNumber === mn).flatMap((s) => s.sizes).reduce((n, x) => n + x.qty, 0);
  assert.equal(sum("shop", "OLD-100"), 8);
  assert.equal(sum("warehouse", "OLD-100"), 7);
  assert.equal(sum("warehouse", "OLD-200"), 4);
  assert.equal(series.flatMap((s) => s.sizes).reduce((n, x) => n + x.qty, 0), 19, "لا نقص ولا تكرار");
  const old = await db.collection("product_models").findOne({ modelNumber: "OLD-100" });
  assert.equal(old.sizes[1].shopQty, 5, "الحقول القديمة محفوظة للتراجع");
});

suite("إعادة التشغيل آمنة (idempotent)", async () => {
  const out = run("--apply");
  assert.match(out, /أرتال رصيد ستُنشأ: 0/);
  assert.equal(await db.collection("series").countDocuments(), 3);
});

suite("بعد الترحيل: الأرقام نفسها من availability.service، والعمليات تعمل على أرتال الرصيد", async () => {
  const ProductModel = require("../../src/models/productModel.model");
  const availability = require("../../src/services/availability.service");
  const doc = await ProductModel.findOne({ modelNumber: "OLD-100" });
  const h = await availability.hydrate(doc);
  const m = h.sizes.find((s) => s.size === "M");
  assert.deepEqual([m.shopQty, m.warehouseQty], [5, 7]);
  assert.deepEqual([h.sizes.find((s) => s.size === "L").shopQty, h.sizes.find((s) => s.size === "L").warehouseQty], [0, 0]);

  const stock = require("../../src/services/stock.service");
  const { presentModel } = require("../../src/middleware/presenters/model.presenter");
  const out = await stock.transfer({ modelNumber: "OLD-100", from: "warehouse", to: "shop", items: [{ size: "M", qty: 7 }] });
  assert.deepEqual(presentModel(out.model).totals, { shop: 15, warehouse: 0, combined: 15 });
  await assert.rejects(() => stock.transfer({ modelNumber: "OLD-100", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }] }), /غير كافية/);
});
