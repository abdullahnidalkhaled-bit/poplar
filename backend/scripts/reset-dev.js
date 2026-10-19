/*
 * مسح قاعدة التطوير القابلة للمسح بالكامل (كل مجموعاتها وفهارسها)، ثم التحقق من أنها فارغة.
 *
 *   npm run reset-dev -- --confirm-db=<الاسم> [--mark-disposable]
 *
 * يعمل فقط عبر بوابة الأمان (scripts/lib/safety.js): محلي، غير إنتاج، اسم مُؤكَّد، موسوم قابلاً للمسح، ولا مجموعات غريبة.
 * لا يمسّ أي قاعدة أخرى ولا ملفات ولا .env ولا أسرار المصادقة. وثيقة الوسم _environment وحدها تبقى.
 * بعده بالترتيب:  npm run migrate:suppliers -- --apply   ثم   npm run seed -- --confirm-db=<الاسم>
 */
const mongoose = require("mongoose");
// المسح لا يجوز أن يُعيد إنشاء مجموعات تلقائياً: نوقف الإنشاء والفهرسة التلقائيين قبل تحميل أي نموذج (الترحيل هو من يبنيها)
mongoose.set("autoCreate", false);
mongoose.set("autoIndex", false);
const env = require("../src/config/env");
const { MARKER, preflight, assertDisposable } = require("./lib/safety");

async function main() {
  const argv = process.argv.slice(2);
  preflight({ uri: env.mongoUri, argv }); // قبل أي اتصال
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await assertDisposable({ mongoose, argv, uri: env.mongoUri });

  const db = mongoose.connection.db;
  const dropped = [];
  for (const c of await db.listCollections().toArray()) {
    if (c.name === MARKER || c.name.startsWith("system.")) continue;
    await db.dropCollection(c.name);
    dropped.push(c.name);
  }
  const left = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => n !== MARKER && !n.startsWith("system."));
  if (left.length) throw new Error(`فشل التحقق: بقيت مجموعات: ${left.join(", ")}`);
  console.log(`تم مسح ${dropped.length} مجموعة (${dropped.join(", ") || "لا شيء"}). القاعدة "${mongoose.connection.name}" فارغة الآن (عدا وسم البيئة).`);
}

main()
  .catch((err) => { console.error("فشل:", err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
