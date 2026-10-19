/*
 * ترحيل التجار + الصندوقين على بيانات "قديمة الشكل": جافّ افتراضياً، نسخة احتياطية، تكرار آمن، لا تخمين (أسعار/عملات/نقد)، ورفض التراجع عند وجود بيانات.
 * قاعدة "<اسم>_supmig" تُفرَّغ (اسمها يجب أن يحوي test).
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_supmig$2") : RAW;
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const backups = path.join(__dirname, "..", "..", "backups");
const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "..", "scripts", "migrate-suppliers.js"), ...a], { env: { ...process.env, MONGO_URI: URI }, encoding: "utf8" });
const created = () => (fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => /^(pre-suppliers|suppliers-reconciliation|finance-reconciliation)-/.test(f)) : []);

test("ترحيل التجار والصندوقين: جافّ، تطبيق، تكرار، عدم تخمين الأسعار/النقد/الوحدات، حماية التراجع", { skip }, async () => {
  const mongoose = require("mongoose");
  const before = new Set(created());
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  const db = mongoose.connection.db;
  const oid = () => new mongoose.Types.ObjectId();
  const sup = oid(), invU = oid(), invS = oid(), payU = oid(), payS = oid(), advS = oid(), purU = oid(), purS = oid();
  const sz = (q) => [{ size: "M", initialQty: q, qty: q }];
  await db.collection("series").insertMany([
    { seriesNo: "SER-000001", modelNumber: "OLD-1", model: oid(), location: "shop", kind: "received", status: "active", sizes: sz(2) },           // قديم بلا ownership
    { seriesNo: "SER-000002", modelNumber: "OLD-2", model: oid(), location: "shop", kind: "received", status: "active", sizes: sz(1), supplier: sup, ownership: "consignment" }, // أمانة بلا سعر
  ]);
  const base = { supplier: sup, rate: 0, date: new Date(), createdAt: new Date(), updatedAt: new Date() };
  // فواتير قديمة (قيم مكافئة بالدولار كانت تُخزَّن بدل الوحدة الأصلية)
  await db.collection("supplier_invoices").insertMany([
    { _id: invU, supplier: sup, invoiceNo: "U-1", invoiceKey: "U-1", kind: "purchase", invoiceDate: new Date(), currency: "USD", amount: 100.25, amountUsd: 100.25, amountUsdMinor: 10025, status: "posted", seriesNos: [], shipmentRefs: [] },
    { _id: invS, supplier: sup, invoiceNo: "S-1", invoiceKey: "S-1", kind: "purchase", invoiceDate: new Date(), currency: "SYP", rate: 15000, amount: 9000000, amountUsd: 600, amountUsdMinor: 60000, status: "posted", seriesNos: [], shipmentRefs: [] },
  ]);
  await db.collection("supplier_entries").insertMany([
    { _id: purU, ...base, ref: "SUP-000001", type: "purchase", currency: "USD", delta: 100.25, deltaMinor: 10025, amount: 100.25, amountUsd: 100.25, usdMinor: 10025, invoice: invU },
    { _id: payU, ...base, ref: "SUP-000002", type: "payment", currency: "USD", delta: -40.1, deltaMinor: -4010, amount: 40.1, amountUsd: 40.1, usdMinor: 4010, invoice: invU },
    { _id: purS, ...base, ref: "SUP-000003", type: "purchase", currency: "SYP", rate: 15000, delta: 600, deltaMinor: 60000, amount: 9000000, amountUsd: 600, usdMinor: 60000, invoice: invS },
    { _id: payS, ...base, ref: "SUP-000004", type: "payment", currency: "SYP", rate: 15000, delta: -300, deltaMinor: -30000, amount: 4500000, amountUsd: 300, usdMinor: 30000, invoice: invS },
    { _id: advS, ...base, ref: "SUP-000005", type: "advance", currency: "SYP", rate: 15000, delta: -100, deltaMinor: -10000, amount: 1500000, amountUsd: 100, usdMinor: 10000 },
  ]);
  await db.collection("supplier_allocations").insertMany([
    { ref: "ALC-000001", supplier: sup, kind: "apply", entry: payU, invoice: invU, amountMinor: 4010, source: "direct" },              // دولار/دولار: صحيحة أصلاً
    { ref: "ALC-000002", supplier: sup, kind: "apply", entry: payS, invoice: invS, amountMinor: 30000, source: "direct" },             // ليرة مباشرة: تُعاد من القيد (4,500,000)
    { ref: "ALC-000003", supplier: sup, kind: "apply", entry: advS, invoice: invS, amountMinor: 10000, source: "manual" },             // ليرة يدوي بقيم دولارية: غامض
  ]);
  const item = (cur, price, qty) => ({ series: oid(), seriesNo: "SER-X", size: "M", qty, unitAmount: price, currency: cur, rate: cur === "SYP" ? 15000 : 0, lineAmount: price * qty, lineUsdMinor: 1 });
  await db.collection("supplier_settlements").insertMany([
    { number: 1, ref: "SST-000001", supplier: sup, idempotencyKey: "k1", items: [item("USD", 30, 2)], totalQty: 2, totalUsdMinor: 6000, status: "posted" },
    { number: 2, ref: "SST-000002", supplier: sup, idempotencyKey: "k2", items: [item("SYP", 300000, 1)], totalQty: 1, totalUsdMinor: 2000, status: "posted" },
  ]);
  await db.collection("suppliers").insertOne({ _id: sup, name: "قديم", nameKey: "قديم", phoneKey: "", active: true });
  // نقد تاريخي بلا حركات: يُبلَّغ ولا يُرحَّل
  const invId = oid(), retId = oid();
  await db.collection("invoices").insertOne({ _id: invId, number: 77, currency: "SYP", status: "completed", totalPaid: 450000, cashDue: 450000, items: [], createdAt: new Date() });
  await db.collection("returns").insertOne({ _id: retId, number: 5, invoice: invId, currency: "USD", cashRefund: 12, createdAt: new Date() });

  // 1) جاف: لا كتابة ولا ملفات، والتقرير يشمل المطابقة اليدوية
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /تجربة جافة/);
  assert.match(dry.stdout, /customerInvoicesWithoutCash/);
  assert.match(dry.stdout, /supplierPaymentsWithoutCash/);
  assert.equal(await db.collection("series").countDocuments({ ownership: { $exists: false } }), 1);
  assert.equal(await db.collection("supplier_entries").countDocuments({ amountMinor: { $exists: true } }), 0);
  assert.equal(await db.collection("cash_movements").countDocuments(), 0);
  assert.deepEqual(created().filter((f) => !before.has(f)), []);

  // 2) تطبيق
  const apply = run("--apply");
  assert.equal(apply.status, 0, apply.stderr + apply.stdout);
  const ser = await db.collection("series").find().sort({ seriesNo: 1 }).toArray();
  assert.equal(ser[0].ownership, "owned");
  assert.equal(ser[1].ownership, "consignment", "الأمانة لم تُصنَّف مملوكة");
  assert.equal(ser[1].consignment?.price?.amount, undefined, "لم يُخترع سعر اتفاق");
  const e = Object.fromEntries((await db.collection("supplier_entries").find().toArray()).map((x) => [x.ref, x]));
  assert.deepEqual([e["SUP-000001"].amountMinor, e["SUP-000001"].signedMinor], [10025, 10025]);
  assert.deepEqual([e["SUP-000002"].amountMinor, e["SUP-000002"].signedMinor], [4010, -4010]);
  assert.deepEqual([e["SUP-000003"].amountMinor, e["SUP-000003"].signedMinor], [9000000, 9000000], "الليرة بمبلغها الأصلي لا بمعادلها الدولاري");
  assert.deepEqual([e["SUP-000004"].amountMinor, e["SUP-000004"].signedMinor], [4500000, -4500000]);
  assert.deepEqual([e["SUP-000005"].amountMinor, e["SUP-000005"].signedMinor], [1500000, -1500000]);
  assert.equal((await db.collection("supplier_invoices").findOne({ _id: invS })).amountMinor, 9000000);
  const al = Object.fromEntries((await db.collection("supplier_allocations").find().toArray()).map((x) => [x.ref, x]));
  assert.deepEqual([al["ALC-000001"].currency, al["ALC-000001"].creditCurrency, al["ALC-000001"].amountMinor], ["USD", "USD", 4010]);
  assert.deepEqual([al["ALC-000002"].currency, al["ALC-000002"].amountMinor, al["ALC-000002"].creditMinor], ["SYP", 4500000, 4500000], "أُعيد حتمياً من قيد الدفعة بالليرة");
  assert.equal(al["ALC-000003"].needsReview, true, "الغامض يُوسَم للمراجعة ولا يدخل الأرصدة");
  const st = Object.fromEntries((await db.collection("supplier_settlements").find().toArray()).map((x) => [x.ref, x]));
  assert.deepEqual([st["SST-000001"].currency, st["SST-000001"].totalMinor], ["USD", 6000]);
  assert.equal(st["SST-000002"].totalMinor, undefined, "تسوية بالليرة قديمة لم تُمسّ (مراجعة يدوية)");
  assert.equal(await db.collection("cash_movements").countDocuments(), 0, "لا حركات نقد تاريخية مخترعة");
  const files = created().filter((f) => !before.has(f));
  assert.ok(files.some((f) => f.startsWith("pre-suppliers-")), "نسخة احتياطية");
  const rec = files.find((f) => f.startsWith("finance-reconciliation-"));
  assert.ok(rec, "تقرير مطابقة");
  const report = JSON.parse(fs.readFileSync(path.join(backups, rec), "utf8"));
  assert.equal(report.cash.customerInvoicesWithoutCash.count, 1);
  assert.equal(report.cash.customerRefundsWithoutCash.count, 1);
  assert.equal(report.cash.supplierPaymentsWithoutCash.count, 3, "دفعتان وسلفة بلا حركات نقد");
  assert.deepEqual(report.consignmentSeriesWithoutPrice.map((s) => s.seriesNo), ["SER-000002"]);
  assert.equal(report.allocationsNeedingReview.length, 1);
  assert.equal(report.settlementsNeedingReview.length, 1);

  // 3) إعادة التطبيق: لا تغيير
  const again = run("--apply");
  assert.equal(again.status, 0, again.stderr);
  assert.equal((await db.collection("supplier_allocations").find({ needsReview: true }).toArray()).length, 1);
  assert.equal(await db.collection("cash_movements").countDocuments(), 0);

  // 4) تراجع مرفوض مع وجود بيانات
  const rb = run("--rollback", "--apply");
  assert.notEqual(rb.status, 0);
  assert.match(rb.stderr, /رفض التراجع/);
  assert.ok(await db.collection("series").findOne({ ownership: "consignment" }), "لم يُمسّ شيء");

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  for (const f of created()) if (!before.has(f)) fs.rmSync(path.join(backups, f), { force: true });
});
