/*
 * بوابة أمان للعمليات المدمّرة (مسح/إعادة بناء بيانات التطوير). لا تعتمد على اسم القاعدة أبداً. تُرفض العملية ما لم تتحقق كلها:
 *  1) ليست بيئة إنتاج (NODE_ENV أو POPLAR_ENV = production).
 *  2) العنوان محلي صراحةً (localhost / 127.0.0.1 / ::1) وليس mongodb+srv ولا مضيفاً بعيداً.
 *  3) اسم القاعدة المتصل بها فعلاً مُؤكَّد صراحةً بالوسيط  --confirm-db=<الاسم>  (يطابق القاعدة الفعلية، لا قيمة افتراضية).
 *  4) القاعدة موسومة صراحةً كقاعدة قابلة للمسح بوثيقة _environment { disposable: true, database: <الاسم> }.
 *     الوسم يُنشأ مرة واحدة فقط بالوسيط --mark-disposable (موافقة صريحة من المالك على هذه القاعدة بعينها).
 *  5) كل مجموعات القاعدة تخص هذا المشروع فقط: وجود أي مجموعة غريبة يعني قاعدة مشتركة/مجهولة فتُرفض.
 * لا تُقرأ أي متغيرات احتياطية: العنوان الوحيد هو MONGO_URI الذي يستعمله التطبيق، ويُطبع الهدف قبل أي حذف.
 */
const fs = require("fs");
const path = require("path");

const MARKER = "_environment";
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SYSTEM_DBS = new Set(["admin", "config", "local"]);

const arg = (argv, name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};

// مجموعات المشروع المعروفة: من تعريفات النماذج نفسها (المصدر الوحيد)
function knownCollections() {
  const dir = path.join(__dirname, "..", "..", "src", "models");
  const names = new Set([MARKER]);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".model.js"))) {
    const m = require(path.join(dir, f));
    if (m?.collection?.name) names.add(m.collection.name);
  }
  return names;
}

// يحلّل العنوان بلا اتصال: { srv, hosts[], db }
function parseUri(uri) {
  const m = String(uri || "").match(/^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/);
  if (!m) return { srv: false, hosts: [], db: "" };
  const hosts = m[2].split(",").map((h) => h.replace(/:\d+$/, "").toLowerCase());
  return { srv: !!m[1], hosts, db: decodeURIComponent(m[3] || "") };
}

// فحوص ما قبل الاتصال (لا تلمس قاعدة بيانات)
function preflight({ uri, argv, env = process.env }) {
  if (env.NODE_ENV === "production" || env.POPLAR_ENV === "production") throw new Error("رفض: بيئة إنتاج (NODE_ENV/POPLAR_ENV=production). العمليات المدمّرة ممنوعة.");
  if (!uri) throw new Error("رفض: MONGO_URI مفقود.");
  const t = parseUri(uri);
  if (t.srv) throw new Error("رفض: عنوان mongodb+srv (استضافة سحابية/مشتركة) غير مسموح لهذه العملية.");
  if (!t.hosts.length || !t.hosts.every((h) => LOCAL.has(h))) throw new Error(`رفض: المضيف ليس محلياً (${t.hosts.join(", ") || "؟"}). المسموح localhost/127.0.0.1 فقط.`);
  if (!t.db) throw new Error("رفض: اسم القاعدة غير محدد في MONGO_URI.");
  if (SYSTEM_DBS.has(t.db)) throw new Error(`رفض: "${t.db}" قاعدة نظام.`);
  const confirm = arg(argv, "confirm-db");
  if (typeof confirm !== "string" || confirm !== t.db) throw new Error(`رفض: أكّد اسم القاعدة صراحةً بالوسيط --confirm-db=${t.db}`);
  return t;
}

/**
 * يتحقق من أن القاعدة المتصل بها فعلاً قابلة للمسح، ويطبع ملخصها. يرمي خطأ عند أي شك.
 * mongoose يجب أن يكون متصلاً بالعنوان نفسه الذي مرّ في preflight.
 */
async function assertDisposable({ mongoose, argv, uri, log = console.log }) {
  const target = preflight({ uri, argv });
  const db = mongoose.connection.db;
  const actual = mongoose.connection.name;
  if (actual !== target.db) throw new Error(`رفض: القاعدة المتصل بها فعلاً "${actual}" تختلف عن المذكورة في العنوان "${target.db}".`);
  const hello = await db.admin().command({ hello: 1 });
  const cols = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  const known = knownCollections();
  const foreign = cols.filter((n) => !known.has(n));
  if (foreign.length) throw new Error(`رفض: القاعدة تحوي مجموعات لا تخص هذا المشروع (${foreign.join(", ")}): قاعدة مشتركة أو مجهولة.`);

  const marker = await db.collection(MARKER).findOne({ _id: "environment" });
  if (marker) {
    if (marker.disposable !== true || marker.database !== actual) throw new Error("رفض: وسم القاعدة لا يطابقها أو لا يقول إنها قابلة للمسح.");
  } else if (arg(argv, "mark-disposable")) {
    await db.collection(MARKER).insertOne({ _id: "environment", disposable: true, database: actual, hosts: target.hosts, markedAt: new Date(), note: "قاعدة تطوير قابلة للمسح بموافقة المالك الصريحة" });
    log(`تم وسم القاعدة "${actual}" كقاعدة تطوير قابلة للمسح (وثيقة ${MARKER}).`);
  } else {
    throw new Error(`رفض: القاعدة "${actual}" غير موسومة كقابلة للمسح. بموافقة المالك الصريحة أضف --mark-disposable (مرة واحدة).`);
  }

  const counts = {};
  for (const n of cols.sort()) counts[n] = await db.collection(n).countDocuments();
  log(`الهدف: القاعدة "${actual}" على ${target.hosts.join(", ")} (${hello.setName ? "replica set" : "standalone"}) — موسومة قابلة للمسح`);
  log("المجموعات وعدد المستندات التي ستتأثر:");
  console.table(counts);
  return { name: actual, counts, deployment: hello.setName ? "replica set" : "standalone" };
}

module.exports = { MARKER, parseUri, preflight, assertDisposable, knownCollections, arg };
