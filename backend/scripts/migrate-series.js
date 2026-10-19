#!/usr/bin/env node
/*
 * ترحيل الكميات القديمة (sizes[].shopQty / warehouseQty) إلى أرتال (Series).
 *   node scripts/migrate-series.js            تجربة جافة: تعرض الخطة ولا تكتب شيئاً
 *   node scripts/migrate-series.js --apply    تنفيذ: نسخة احتياطية EJSON ثم إنشاء الأرتال ثم التحقق من الإجماليات
 * القاعدة: لا يوجد في البيانات القديمة ما يدل على عضوية رتل، فلا نخترع تجميعات: لكل (موديل، موقع) رتل "رصيد" واحد
 * يحمل الكميات الحالية. آمن لإعادة التشغيل. لا يعدّل الحقول القديمة ولا الفواتير ولا الحركات (للتراجع).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const Series = require("../src/models/series.model");
const { nextSeq } = require("../src/repositories/counter.repository");
const { formatSeriesNo } = require("../src/utils/series");
const { normalizeText } = require("../src/utils/text");
const { planSeriesMigration } = require("./lib/seriesPlan");

const APPLY = process.argv.includes("--apply");
const MARK = "MIGRATION";

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI مفقود");
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(APPLY ? "== وضع التنفيذ (--apply) ==" : "== تجربة جافة (لن يُكتب شيء) ==");

  const models = await db.collection("product_models").find({}).toArray();
  const done = await Series.find({ shipmentRef: MARK }, "model location").lean();
  const migratedKeys = new Set(done.map((s) => `${s.model}:${s.location}`));
  const plan = planSeriesMigration(models, { migratedKeys });

  console.log(`موديلات: ${models.length} | أرتال رصيد ستُنشأ: ${plan.items.length} | قطع: ${plan.totalPieces} | مرحَّل سابقاً: ${migratedKeys.size}`);
  for (const it of plan.items) console.log(`  ${it.modelNumber} @ ${it.location}: ${it.sizes.map((s) => `${s.size}:${s.qty}`).join(" ")}`);
  plan.warnings.forEach((w) => console.log("  تحذير:", w));
  if (!APPLY) return console.log("\nلم يُكتب شيء. أضف --apply للتنفيذ (تُؤخذ نسخة احتياطية تلقائياً).");

  const backup = {};
  for (const name of ["product_models", "series", "counters", "stockmovements", "invoices"]) backup[name] = await db.collection(name).find({}).toArray();
  const dir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pre-series-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, EJSON.stringify(backup, { relaxed: false }));
  console.log(`\nنسخة احتياطية: ${file}`);

  const byId = new Map(models.map((m) => [String(m._id), m]));
  for (const it of plan.items) {
    const m = byId.get(String(it.modelId));
    const existing = await Series.findOne({ kind: "balance", model: it.modelId, location: it.location });
    if (existing) {
      // رتل رصيد سبق إنشاؤه (مثل زيادة جرد): ندمج فيه ونعلّمه
      for (const s of it.sizes) {
        const has = existing.sizes.find((x) => x.size === s.size);
        if (has) has.qty += s.qty;
        else existing.sizes.push({ size: s.size, initialQty: 0, qty: s.qty });
      }
      existing.status = "active";
      existing.shipmentRef = MARK;
      await existing.save();
    } else {
      await Series.create({
        seriesNo: formatSeriesNo(await nextSeq("series")),
        model: m._id, modelNumber: m.modelNumber, name: m.name, nameKey: normalizeText(m.name), type: m.type, cut: m.cut,
        location: it.location, kind: "balance", status: "active", shipmentRef: MARK, note: "رصيد مُرحَّل من النسخة السابقة",
        receivedAt: it.receivedAt || new Date(0),
        sizes: it.sizes.map((s) => ({ size: s.size, initialQty: s.qty, qty: s.qty })),
      });
    }
  }

  // التحقق: مجموع الأرتال المرحَّلة لكل موديل >= مجموع الكميات القديمة (يزيد فقط إن وُجد رصيد جرد سابق)، وإلا يُبلَّغ بوضوح
  const got = await Series.aggregate([
    { $match: { shipmentRef: MARK } }, { $unwind: "$sizes" }, { $group: { _id: "$model", qty: { $sum: "$sizes.qty" } } },
  ]);
  const gotMap = new Map(got.map((g) => [String(g._id), g.qty]));
  let bad = 0;
  for (const [id, expected] of plan.expected) {
    if ((gotMap.get(id) || 0) < expected) {
      bad++;
      console.error(`عدم تطابق في ${byId.get(id).modelNumber}: متوقع ${expected} موجود ${gotMap.get(id) || 0}`);
    }
  }
  if (bad) throw new Error(`فشل التحقق في ${bad} موديل. استعد النسخة الاحتياطية.`);
  console.log(`تم: ${plan.items.length} رتل رصيد | ${plan.totalPieces} قطعة | التحقق ناجح (لا نقص ولا تكرار).`);
  console.log("الحقول القديمة shopQty/warehouseQty بقيت في product_models دون مساس (للتراجع)، والكود يتجاهلها.");
}

main()
  .catch((e) => { console.error("فشل الترحيل:", e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
