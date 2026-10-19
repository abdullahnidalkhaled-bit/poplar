/*
 * نسخة احتياطية كاملة (EJSON) لكل مجموعات قاعدة البيانات الحالية إلى backend/backups/<name>-<time>/ قبل أي عملية مدمّرة.
 *   npm run backup-db
 * للقراءة فقط: لا يكتب في القاعدة. الاستعادة: أعد إدراج الملفات بـ mongoimport --jsonArray أو بسكربت EJSON.parse.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const env = require("../src/config/env");

async function main() {
  if (!env.mongoUri) throw new Error("MONGO_URI مفقود.");
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const dir = path.join(__dirname, "..", "backups", `${mongoose.connection.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(dir, { recursive: true });
  const summary = {};
  for (const c of await db.listCollections().toArray()) {
    if (c.name.startsWith("system.")) continue;
    const docs = await db.collection(c.name).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${c.name}.json`), EJSON.stringify(docs, { relaxed: false }, 2));
    summary[c.name] = docs.length;
  }
  console.log(`نسخة احتياطية في: ${dir}`);
  console.table(summary);
}

main().catch((e) => { console.error("فشل:", e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
