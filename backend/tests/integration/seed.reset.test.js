/*
 * سير العمل: بوابة الأمان للمسح، الترحيل على قاعدة نظيفة وإعادته، البذر مرتين دون تكرار، تطابق الصندوقين، وسيناريوهات المحاسبة المبذورة.
 * قاعدة "<اسم>_seedflow" (اسمها يجب أن يحوي test) تُنشأ وتُمسح هنا عبر السكربتات الفعلية كعمليات منفصلة.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_seedflow$2") : RAW;
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const DB = URI ? (URI.match(/\/([^/?]+)(\?|$)/) || [])[1] : "";
const root = path.join(__dirname, "..", "..");
const backups = path.join(root, "backups");
const script = (name, args = [], env = {}) =>
  spawnSync(process.execPath, [path.join(root, "scripts", name), ...args], { env: { ...process.env, MONGO_URI: URI, ...env }, encoding: "utf8", timeout: 240000 });
const created = () => (fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => /^(pre-suppliers|finance-reconciliation|suppliers-reconciliation)-/.test(f)) : []);

let mongoose, db, before;
const names = async () => (await db.listCollections().toArray()).map((c) => c.name).filter((n) => n !== "_environment" && !n.startsWith("system."));
const snapshot = async () => {
  const counts = {};
  for (const n of (await names()).sort()) counts[n] = await db.collection(n).countDocuments();
  const cash = { USD: 0, SYP: 0 };
  for (const m of await db.collection("cash_movements").find().toArray()) cash[m.currency] += (m.direction === "in" ? 1 : -1) * m.amountMinor;
  const stock = {};
  for (const s of await db.collection("series").find().toArray()) stock[s.modelNumber] = (stock[s.modelNumber] || 0) + s.sizes.reduce((n, x) => n + x.qty, 0);
  const sup = (await db.collection("suppliers").find().sort({ name: 1 }).toArray()).map((s) => s.name);
  return { counts, cash, stock, sup };
};

test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  db = mongoose.connection.db;
  await mongoose.connection.dropDatabase();
  before = new Set(created());
});
test.after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  for (const f of created()) if (!before.has(f)) fs.rmSync(path.join(backups, f), { force: true });
});

test("بوابة الأمان ترفض: إنتاج، SRV، مضيف بعيد، بلا تأكيد، تأكيد خاطئ، غير موسومة، قاعدة بمجموعات غريبة، ولا يُحذف شيء", { skip }, async () => {
  await db.collection("suppliers").insertOne({ name: "يجب أن يبقى", nameKey: "x", phoneKey: "", active: true });
  await db.collection("product_models").insertOne({ modelNumber: "KEEP-1" });
  const keep = async () => assert.equal((await db.collection("suppliers").countDocuments()) + (await db.collection("product_models").countDocuments()), 2, "لم يُحذف شيء");
  const refuse = (r, re, why) => { assert.notEqual(r.status, 0, why); assert.match(r.stderr, re, why + " :: " + r.stderr); };

  refuse(script("reset-dev.js", [`--confirm-db=${DB}`, "--mark-disposable"], { NODE_ENV: "production" }), /إنتاج/, "production");
  refuse(script("reset-dev.js", [`--confirm-db=${DB}`, "--mark-disposable"], { POPLAR_ENV: "production" }), /إنتاج/, "POPLAR_ENV");
  refuse(script("reset-dev.js", [`--confirm-db=${DB}`, "--mark-disposable"], { MONGO_URI: "mongodb+srv://u:p@cluster0.example.net/poplar" }), /srv/i, "srv");
  refuse(script("reset-dev.js", [`--confirm-db=poplar`, "--mark-disposable"], { MONGO_URI: "mongodb://10.20.30.40:27017/poplar" }), /محلياً/, "remote host");
  refuse(script("reset-dev.js", [`--confirm-db=${DB}`], { MONGO_URI: "mongodb://127.0.0.1:27017,10.0.0.9:27017/poplar_x" }), /محلياً/, "mixed hosts");
  refuse(script("reset-dev.js", ["--mark-disposable"]), /confirm-db/, "no confirm");
  refuse(script("reset-dev.js", ["--confirm-db=somethingelse", "--mark-disposable"]), /confirm-db/, "wrong confirm");
  refuse(script("reset-dev.js", [`--confirm-db=${DB}`]), /غير موسومة/, "not marked");
  refuse(script("seed.js", [`--confirm-db=${DB}`, "--reset"]), /غير موسومة/, "seed not marked");
  refuse(script("seed.js", ["--reset"]), /confirm-db/, "seed without confirm");
  await keep();

  // قاعدة تحوي مجموعة غريبة (قاعدة مشتركة/مجهولة): ترفض حتى مع التأكيد والوسم
  await db.collection("somebody_elses_data").insertOne({ x: 1 });
  refuse(script("reset-dev.js", [`--confirm-db=${DB}`, "--mark-disposable"]), /لا تخص هذا المشروع/, "foreign collection");
  assert.equal(await db.collection("somebody_elses_data").countDocuments(), 1);
  assert.equal(await db.collection("_environment").countDocuments(), 0, "لم يُوسَم");
  await keep();
  await db.collection("somebody_elses_data").drop();

  // وسم يخص قاعدة أخرى لا يصلح
  await db.collection("_environment").insertOne({ _id: "environment", disposable: true, database: "another_db" });
  refuse(script("reset-dev.js", [`--confirm-db=${DB}`]), /لا يطابقها/, "marker for other db");
  await db.collection("_environment").deleteMany({});
  await keep();
});

test("سير العمل الكامل: مسح → ترحيل (مرتان) → بذر (مرتان) بلا تكرار، وفهارس سليمة", { skip }, async () => {
  // مسح (موافقة صريحة بالوسم) ثم التحقق من الفراغ
  const reset = script("reset-dev.js", [`--confirm-db=${DB}`, "--mark-disposable"]);
  assert.equal(reset.status, 0, reset.stderr + reset.stdout);
  assert.deepEqual(await names(), [], "فارغة بعد المسح");
  assert.equal(await db.collection("_environment").countDocuments(), 1);

  // ترحيل على قاعدة نظيفة ثم إعادته: لا تكرار فهارس ولا مستندات
  assert.equal(script("migrate-suppliers.js", ["--apply"]).status, 0);
  const idx1 = {};
  for (const n of await names()) idx1[n] = (await db.collection(n).indexes()).map((i) => i.name).sort();
  assert.ok(idx1.cash_movements.includes("idempotencyKey_1"), "فهرس مفتاح التكرار للنقد");
  const cashIdx = (await db.collection("cash_movements").indexes()).find((i) => i.name === "idempotencyKey_1");
  assert.equal(cashIdx.unique, true);
  assert.ok(idx1.supplier_entries.length >= 5 && idx1.users.length >= 2 && idx1.invoices.length >= 2);
  assert.equal(script("migrate-suppliers.js", ["--apply"]).status, 0);
  const idx2 = {};
  for (const n of await names()) idx2[n] = (await db.collection(n).indexes()).map((i) => i.name).sort();
  assert.deepEqual(idx2, idx1, "إعادة الترحيل لم تغيّر الفهارس");
  assert.equal((await snapshot()).counts.cash_movements, 0, "الترحيل لا يخلق حركات نقد");
  assert.equal((await db.collection("suppliers").countDocuments()) + (await db.collection("supplier_entries").countDocuments()), 0, "ولا يخلق سجلات مالية");

  // بذر أول
  const seed1 = script("seed.js", [`--confirm-db=${DB}`]);
  assert.equal(seed1.status, 0, seed1.stderr + seed1.stdout);
  assert.match(seed1.stdout, /مطابقة الصندوقين/);
  const A = await snapshot();
  // بذر ثانٍ فوق بيانات موجودة بلا --reset: يُرفض ولا يغيّر شيئاً
  const refused = script("seed.js", [`--confirm-db=${DB}`]);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(await snapshot(), A);
  // بذر ثانٍ بإعادة البناء: النتيجة نفسها تماماً (لا تكرار)
  const seed2 = script("seed.js", [`--confirm-db=${DB}`, "--reset"]);
  assert.equal(seed2.status, 0, seed2.stderr + seed2.stdout);
  const B = await snapshot();
  assert.deepEqual(B, A, "إعادة البذر أنتجت البيانات والأرصدة نفسها");
  // لا مفاتيح تكرار مكررة
  for (const [c, f] of [["cash_movements", "idempotencyKey"], ["supplier_entries", "idempotencyKey"], ["expenses", "idempotencyKey"]]) {
    const keys = (await db.collection(c).find({ [f]: { $type: "string" } }).toArray()).map((d) => d[f]);
    assert.equal(new Set(keys).size, keys.length, `${c}: مفاتيح مكررة`);
  }
  assert.ok(A.counts.cash_movements > 30 && A.counts.suppliers === 8 && A.counts.supplier_settlements === 3);
});

test("البيانات المبذورة: سيناريوهات محاسبية صحيحة، تطابق الصندوقين، لوحة المالية، وصلاحيات الموظف", { skip }, async () => {
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const check = await verifyIntegrity(db);
  assert.deepEqual(check.problems, [], check.problems.join("\n"));

  const cash = await db.collection("cash_movements").find().toArray();
  const sum = (c) => cash.filter((m) => m.currency === c).reduce((n, m) => n + (m.direction === "in" ? 1 : -1) * m.amountMinor, 0);
  const opening = (c) => cash.filter((m) => m.currency === c && m.source.kind === "manual" && m.direction === "in").reduce((n, m) => n + m.amountMinor, 0);
  assert.equal(opening("USD"), 800000);        // 8,000$ بالسنت
  assert.equal(opening("SYP"), 40000000);
  assert.ok(cash.every((m) => ["USD", "SYP"].includes(m.currency) && Number.isInteger(m.amountMinor)));
  assert.equal(sum("USD"), check.summary.USD.balanceMinor);
  assert.equal(sum("SYP"), check.summary.SYP.balanceMinor);

  // الفواتير والتخصيصات لا تنشئ نقداً
  const entries = await db.collection("supplier_entries").find().toArray();
  const entCash = cash.filter((m) => m.source.kind === "supplier_entry");
  for (const m of entCash) assert.ok(["payment", "advance"].includes(entries.find((e) => String(e._id) === String(m.source.id)).type));
  const outs = entCash.filter((m) => !m.reverses);
  const paid = entries.filter((e) => ["payment", "advance"].includes(e.type));
  assert.equal(outs.length, paid.length, "لكل دفعة/سلفة حركة نقد واحدة بالضبط");
  const allocs = await db.collection("supplier_allocations").find({ kind: "apply" }).toArray();
  assert.ok(allocs.some((a) => a.source === "manual") && allocs.some((a) => a.crossCurrency), "تخصيص يدوي (سلفة على فاتورة) ودفع عبر عملتين صريح");
  assert.equal(cash.filter((m) => allocs.some((a) => String(a._id) === String(m.source.id))).length, 0);
  assert.equal(await db.collection("supplier_invoices").countDocuments({ kind: "purchase" }) > 0, true);
  // الدفع عبر العملتين: فاتورة بالدولار، النقد من الليرة فقط
  const cross = entries.find((e) => e.crossCurrency?.invoiceCurrency === "USD");
  assert.equal(cross.currency, "SYP");
  assert.deepEqual(entCash.filter((m) => String(m.source.id) === String(cross._id)).map((m) => [m.currency, m.direction, m.amountMinor]), [["SYP", "out", 6000000]]);

  // أمانة: تسويات بعملتين منفصلتين، واحدة معكوسة، وإرجاعات من المحل والمستودع، وحركة مخزون مرتبطة
  const sts = await db.collection("supplier_settlements").find().toArray();
  assert.deepEqual([...new Set(sts.map((s) => s.currency))].sort(), ["SYP", "USD"]);
  assert.equal(sts.filter((s) => s.status === "reversed").length, 1);
  const rets = await db.collection("supplier_returns").find().toArray();
  const locs = new Set(rets.flatMap((r) => r.items.map((i) => i.location)));
  assert.ok(locs.has("shop") && locs.has("warehouse"));
  assert.equal(await db.collection("stockmovements").countDocuments({ type: "supplier_return" }) >= 3, true);
  const unpricedSettled = (await db.collection("series").find({ ownership: "consignment" }).toArray()).filter((s) => s.sizes.some((z) => z.settledQty > 0) && !(s.consignment?.price?.amount > 0));
  assert.equal(unpricedSettled.length, 0, "لا تسوية بلا سعر اتفاق صريح");

  // مصروفات بالعملتين وواحد معكوس بحركة عكسية، وإلغاء فاتورة بالليرة بحركة عكسية
  const exps = await db.collection("expenses").find().toArray();
  assert.deepEqual([...new Set(exps.map((e) => e.currency))].sort(), ["SYP", "USD"]);
  const rev = exps.find((e) => e.status === "reversed");
  assert.ok(cash.some((m) => m.type === "expense_reversal" && String(m.source.id) === String(rev._id)));
  const cancelledSyp = await db.collection("invoices").findOne({ status: "cancelled", currency: "SYP" });
  assert.ok(cancelledSyp && cash.some((m) => m.type === "sale_cancellation" && String(m.source.id) === String(cancelledSyp._id) && m.currency === "SYP"));
  assert.ok(cash.some((m) => m.type === "customer_refund" && m.currency === "SYP") && cash.some((m) => m.type === "customer_refund" && m.currency === "USD"), "رد نقدي بالعملتين");

  // ---- عبر التطبيق نفسه
  const { createApp } = require("../../src/app");
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const login = async (u, p) => { const r = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: u, password: p }) }); return { r, cookie: r.headers.getSetCookie?.().find((c) => c.startsWith("poplar_sid="))?.split(";")[0], csrf: (await r.json()).csrfToken }; };
    const get = (s, p) => fetch(base + p, { headers: { Cookie: s.cookie } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
    const admin = await login("admin", "Poplar-Local-2026!");
    const emp = await login("sara", "Shop-Staff-2026");
    assert.equal(admin.r.status, 200);
    assert.equal(emp.r.status, 200);

    const rng = `from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2027-01-01T00:00:00Z")}`;
    const d = (await get(admin, `/finance/dashboard?${rng}`)).json;
    assert.equal(Math.round(d.USD.balance * 100), check.summary.USD.balanceMinor);
    assert.equal(d.SYP.balance, check.summary.SYP.balanceMinor);
    const invs = await db.collection("invoices").find({ status: "completed" }).toArray();
    assert.equal(Math.round(d.USD.revenue * 100), invs.filter((i) => i.currency === "USD").reduce((n, i) => n + Math.round(i.totalPaid * 100), 0));
    assert.equal(d.SYP.revenue, invs.filter((i) => i.currency === "SYP").reduce((n, i) => n + Math.round(i.totalPaid), 0));
    assert.equal(Math.round(d.USD.expenses * 100), exps.filter((e) => e.currency === "USD" && e.status === "posted").reduce((n, e) => n + e.amountMinor, 0));
    assert.equal(d.SYP.expenses, exps.filter((e) => e.currency === "SYP" && e.status === "posted").reduce((n, e) => n + e.amountMinor, 0));
    assert.equal(d.SYP.netProfit, null, "ربح الليرة غير متاح (تكلفة بالدولار)");
    assert.equal(d.SYP.cogs, null);
    assert.ok(d.USD.netProfit !== null);
    assert.ok(!JSON.stringify(d).match(/combined|grandTotal/));

    // حالات الموردين: ليرة/دولار، مستحق/سلفة، مختلطة، مسددة
    const list = (await get(admin, "/suppliers?limit=100&active=all")).json.items;
    const has = (pred) => list.some(pred);
    assert.ok(has((x) => x.positions.SYP.grossPayable > 0 && x.positions.USD.grossPayable === 0), "مستحق بالليرة فقط");
    assert.ok(has((x) => x.positions.USD.grossPayable > 0 && x.positions.SYP.grossPayable === 0 && x.status === "due"), "مستحق بالدولار فقط");
    assert.ok(has((x) => x.positions.SYP.advance > 0 && x.status === "advance"), "سلفة بالليرة");
    assert.ok(has((x) => x.positions.USD.advance > 0 && x.status === "advance"), "سلفة بالدولار");
    assert.ok(has((x) => x.status === "mixed"), "مختلط");
    assert.ok(has((x) => x.status === "settled" && x.active), "مسدد");
    const sum = (await get(admin, "/suppliers/summary")).json;
    assert.deepEqual(Object.keys(sum.totals).sort(), ["SYP", "USD"]);

    // الموظف: لا يصل لأي ماليات أو موردين
    for (const p of [`/finance/dashboard?${rng}`, "/finance/cash", "/finance/expenses", "/suppliers", "/suppliers/summary", "/reports/summary?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z"]) assert.equal((await get(emp, p)).status, 403, p);
    const empInv = await get(emp, "/invoices");
    assert.equal(empInv.status, 200);
    assert.ok(!/costUsd|profitUsd|"costPrice"/.test(JSON.stringify(empInv.json)), "الموظف لا يرى التكلفة/الربح");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
