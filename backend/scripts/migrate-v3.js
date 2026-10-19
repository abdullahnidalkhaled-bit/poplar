#!/usr/bin/env node
/*
 * ترحيل البيانات من النسخة 2 (products/variants/color) إلى النسخة 3 (product_models/sizes).
 *   node scripts/migrate-v3.js            تجربة جافة: تعرض الخطة ولا تكتب شيئاً
 *   node scripts/migrate-v3.js --apply    تنفيذ: نسخة احتياطية كاملة أولاً ثم الترحيل
 * آمن لإعادة التشغيل (idempotent). مجموعة products القديمة لا تُعدَّل ولا تُحذف أبداً.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const ProductModel = require("../src/models/productModel.model");
const { planMigration, groupKey } = require("./lib/plan");
const { normalizeText } = require("../src/utils/text");

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI مفقود");
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(APPLY ? "== وضع التنفيذ (--apply) ==" : "== تجربة جافة (لن يُكتب شيء) ==");

  const legacy = await db.collection("products").find({}).toArray();
  const existing = await ProductModel.find({}, "modelNumber legacy sizes.legacyVariantId sizes.size sizes._id").lean();
  const migratedKeys = new Set(existing.filter((m) => m.legacy?.productId).map((m) => groupKey(m.legacy.productId, m.legacy.style, m.legacy.color)));
  const counters = {};
  for (const c of await db.collection("counters").find({ _id: /^modelno:/ }).toArray()) counters[c._id.slice(8)] = c.seq;

  const plan = planMigration(legacy, { existingModelNumbers: new Set(existing.map((m) => m.modelNumber)), counters, migratedKeys });
  console.log(`منتجات قديمة: ${legacy.length} | موديلات جديدة ستُنشأ: ${plan.models.length} | موديلات مرحَّلة سابقاً: ${migratedKeys.size}`);
  for (const m of plan.models) {
    const d = m.doc;
    console.log(`  ${d.modelNumber}  ${d.brand} ${d.name} [${d.cut || "-"}] ${d.notes}  مقاسات: ${d.sizes.map((s) => `${s.size}(${s.shopQty}/${s.warehouseQty})`).join(" ")}`);
  }
  plan.warnings.forEach((w) => console.log("  تحذير:", w));

  if (!APPLY) {
    console.log("\nلم يُكتب شيء. أضف --apply للتنفيذ (تُؤخذ نسخة احتياطية تلقائياً).");
    return;
  }

  // 1) نسخة احتياطية كاملة (EJSON تحفظ الأنواع كاملة وتصلح للاستعادة)
  const backup = {};
  for (const name of ["products", "invoices", "returns", "stockmovements", "counters", "settings"]) {
    backup[name] = await db.collection(name).find({}).toArray();
  }
  const file = path.join(__dirname, "..", "backups", `pre-v3-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, EJSON.stringify(backup, { relaxed: false }));
  console.log(`\nنسخة احتياطية: ${file}`);

  // 2) إنشاء الموديلات الجديدة
  // الموديل يحمل هوية المقاسات فقط؛ الكميات القديمة تُكتب في الحقول الخام ثم يحوّلها migrate-series.js إلى أرتال
  for (const m of plan.models) {
    const created = await ProductModel.create(m.doc);
    for (const s of m.doc.sizes) {
      await db.collection("product_models").updateOne(
        { _id: created._id, "sizes.size": s.size },
        { $set: { "sizes.$.shopQty": s.shopQty || 0, "sizes.$.warehouseQty": s.warehouseQty || 0 } }
      );
    }
  }
  for (const [prefix, seq] of Object.entries(plan.counters)) {
    await db.collection("counters").updateOne({ _id: `modelno:${prefix}` }, { $max: { seq } }, { upsert: true });
  }

  // 3) خريطة: معرّف المتغيّر القديم → الموديل والمقاس الجدد
  const all = await ProductModel.find({ "legacy.productId": { $exists: true } }).lean();
  const byVariant = new Map();
  const typeByProduct = new Map(legacy.map((p) => [String(p._id), p.category]));
  for (const m of all) for (const s of m.sizes) if (s.legacyVariantId) byVariant.set(String(s.legacyVariantId), { model: m, size: s });

  const remapItem = (it) => {
    if (it.model) return it; // مرحَّل
    const hit = byVariant.get(String(it.variantId));
    const out = { ...it, legacy: { product: it.product, variantId: it.variantId, color: it.color, style: it.style } };
    if (hit) Object.assign(out, { model: hit.model._id, sizeId: hit.size._id, modelNumber: hit.model.modelNumber, size: hit.size.size });
    out.type = it.type || typeByProduct.get(String(it.product));
    out.cut = it.cut ?? it.style ?? "";
    for (const k of ["product", "variantId", "color", "style"]) delete out[k];
    return out;
  };

  let inv = 0, ret = 0, mov = 0;
  for (const doc of await db.collection("invoices").find({ "items.model": { $exists: false } }).toArray()) {
    await db.collection("invoices").updateOne({ _id: doc._id }, { $set: { items: doc.items.map(remapItem) } });
    inv++;
  }
  for (const doc of await db.collection("returns").find({ "items.model": { $exists: false } }).toArray()) {
    await db.collection("returns").updateOne({ _id: doc._id }, { $set: { items: doc.items.map(remapItem) } });
    ret++;
  }
  for (const doc of await db.collection("stockmovements").find({ model: { $exists: false }, variantId: { $exists: true } }).toArray()) {
    const hit = byVariant.get(String(doc.variantId));
    const set = { nameKey: normalizeText(doc.name || ""), legacy: { color: doc.color, style: doc.style } };
    if (hit) Object.assign(set, { model: hit.model._id, sizeId: hit.size._id, modelNumber: hit.model.modelNumber, size: hit.size.size });
    await db.collection("stockmovements").updateOne({ _id: doc._id }, { $set: set, $unset: { product: 1, variantId: 1, color: 1, style: 1 } });
    mov++;
  }
  console.log(`تم: ${plan.models.length} موديل | فواتير معاد ربطها: ${inv} | مرتجعات: ${ret} | حركات: ${mov}`);
  console.log("الخطوة التالية: npm run migrate:series لتحويل الكميات إلى أرتال.");
  console.log("مجموعة products القديمة لم تُمسّ. يمكنك حذفها يدوياً بعد التأكد من سلامة النظام.");
}

main()
  .catch((e) => { console.error("فشل الترحيل:", e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
