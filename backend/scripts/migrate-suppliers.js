/*
 * ترحيل حسابات التجار + الصندوقين المستقلين (ليرة/دولار) لقاعدة موجودة. آمن ومتكرر، ولا يخترع بيانات:
 *   npm run migrate:suppliers                          تجربة جافة (الافتراضي): تقرير كامل بلا أي كتابة
 *   npm run migrate:suppliers -- --apply               نسخة EJSON احتياطية ثم الخطوات أدناه (idempotent)
 *   npm run migrate:suppliers -- --rollback --apply    يزيل حقول الملكية فقط؛ يرفض إن وُجدت بيانات تجار/أمانة/نقد/مصروفات
 *
 * ما يفعله --apply:
 *  1) series بلا ownership => "owned" (الأمانة لا تُخمَّن أبداً).
 *  2) قيود/فواتير التجار القديمة: يُشتق amountMinor/signedMinor من المبلغ الأصلي وعملته (حتمياً). المكافئ الدولاري القديم لا يدخل أي رصيد.
 *  3) تخصيصات قديمة: «direct» تُعاد حتمياً من قيد الدفعة بعملته إن اتحدت العملتان؛ تخصيصات الدولار/الدولار تُوسَم بعملتها؛
 *     أي تخصيص غامض الوحدات (ليرة بقيم دولارية قديمة، يدوي/تلقائي) يُوسَم needsReview ويُستبعد من الأرصدة حتى المراجعة اليدوية.
 *  4) تسويات أمانة قديمة: تُرحَّل فقط إن كانت كلها بالدولار؛ ما فيه بنود بالليرة (كان يُحوَّل لدولار) يُبلَّغ للمراجعة ولا يُمسّ.
 *  5) أرتال أمانة بلا سعر اتفاق: لا يُخترع سعر؛ تُسرد في ملف مطابقة.
 *  6) الصندوقان: تُنشأ المجموعات والفهارس فقط. لا تُنشأ أي حركة نقد تاريخية ولا أرصدة افتتاحية ولا يُصنَّف شيء بالتخمين.
 *     فواتير/مرتجعات/دفعات مورّدين سابقة بلا حركات نقد تُسرد في تقرير المطابقة (backups/finance-reconciliation-*.json)؛
 *     يُدخل المالك رصيداً افتتاحياً لكل صندوق من واجهة المالية (إيداع/سحب يدوي) بعد مراجعته.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const env = require("../src/config/env");

const args = new Set(process.argv.slice(2));
const CREDIT = ["payment", "advance", "credit", "return_credit"];
const toMinorC = (cur, n) => (cur === "SYP" ? Math.round(n || 0) : Math.round((n || 0) * 100));
const sign = (e) => { const v = e.deltaMinor ?? e.delta; if (v != null && v !== 0) return Math.sign(v); return ["purchase", "adjustment"].includes(e.type) ? 1 : CREDIT.includes(e.type) ? -1 : 0; };

async function main() {
  if (!env.mongoUri) throw new Error("MONGO_URI مفقود في .env");
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const C = (n) => db.collection(n);
  const count = (n, q = {}) => C(n).countDocuments(q).catch(() => 0);
  const list = (n, q = {}, proj) => C(n).find(q, proj ? { projection: proj } : {}).toArray().catch(() => []);

  const plan = { series: {}, entries: [], invoices: [], allocations: { fixable: [], direct: [], review: [] }, settlements: { fixable: [], review: [] }, reconciliation: {} };
  const legacyEntries = await list("supplier_entries", { $or: [{ amountMinor: { $exists: false } }, { signedMinor: { $exists: false } }] });
  const legacyInvoices = await list("supplier_invoices", { amountMinor: { $exists: false } });
  const entriesAll = new Map((await list("supplier_entries")).map((e) => [String(e._id), e]));
  const invoicesAll = new Map((await list("supplier_invoices")).map((i) => [String(i._id), i]));
  const legacyAllocs = await list("supplier_allocations", { kind: "apply", $or: [{ currency: { $exists: false } }, { creditCurrency: { $exists: false } }] });
  const legacySettlements = await list("supplier_settlements", { totalMinor: { $exists: false } });

  plan.series = {
    withoutOwnership: await count("series", { ownership: { $exists: false } }),
    consignment: await count("series", { ownership: "consignment" }),
    consignmentWithoutPrice: await count("series", { ownership: "consignment", "consignment.price.amount": { $exists: false } }),
  };
  plan.entries = legacyEntries;
  plan.invoices = legacyInvoices;
  for (const a of legacyAllocs) {
    const inv = invoicesAll.get(String(a.invoice)), ent = entriesAll.get(String(a.entry));
    if (!inv || !ent) { plan.allocations.review.push({ ref: a.ref, reason: "فاتورة أو قيد مفقود" }); continue; }
    if (inv.currency === "USD" && ent.currency === "USD") plan.allocations.fixable.push(a);                         // وحدات السنت صحيحة أصلاً
    else if (a.source === "direct" && inv.currency === ent.currency && String(ent.invoice) === String(inv._id)) plan.allocations.direct.push({ a, ent }); // تُعاد من القيد حتمياً
    else plan.allocations.review.push({ ref: a.ref, reason: `تخصيص (${a.source}) بوحدات دولارية قديمة على عملات (${inv.currency}/${ent.currency}): الوحدة الأصلية غير مؤكدة` });
  }
  for (const s of legacySettlements) {
    const curs = new Set((s.items || []).map((i) => i.currency));
    if (curs.size === 1 && curs.has("USD")) plan.settlements.fixable.push(s);
    else plan.settlements.review.push({ ref: s.ref, reason: "تسوية قديمة ببنود بالليرة كانت تُحوَّل لالتزام بالدولار: يلزم مراجعة يدوية" });
  }

  // النقد التاريخي: لا يُرحَّل بالتخمين، يُبلَّغ فقط
  const cashSourceIds = new Set((await list("cash_movements", {}, { "source.id": 1 })).map((m) => String(m.source?.id)));
  const completedInv = await list("invoices", { status: "completed" }, { number: 1, currency: 1, cashDue: 1, totalPaid: 1 });
  const invNoCash = completedInv.filter((i) => !cashSourceIds.has(String(i._id)));
  const retNoCash = (await list("returns", { cashRefund: { $gt: 0 } }, { number: 1, currency: 1, cashRefund: 1 })).filter((r) => !cashSourceIds.has(String(r._id)));
  const supNoCash = [...entriesAll.values()].filter((e) => ["payment", "advance"].includes(e.type) && !e.reversedBy && !cashSourceIds.has(String(e._id)));
  const sumBy = (arr, f) => arr.reduce((o, x) => { o[x.currency] = (o[x.currency] || 0) + f(x); return o; }, {});
  plan.reconciliation = {
    customerInvoicesWithoutCash: { count: invNoCash.length, byCurrency: sumBy(invNoCash, (i) => i.cashDue ?? i.totalPaid ?? 0) },
    customerRefundsWithoutCash: { count: retNoCash.length, byCurrency: sumBy(retNoCash, (r) => r.cashRefund) },
    supplierPaymentsWithoutCash: { count: supNoCash.length, byCurrency: sumBy(supNoCash, (e) => e.amount || 0) },
    ambiguousCurrency: completedInv.filter((i) => !["USD", "SYP"].includes(i.currency)).length,
  };

  const counts = {};
  for (const c of ["suppliers", "supplier_invoices", "supplier_entries", "supplier_returns", "supplier_allocations", "supplier_settlements", "cash_movements", "expenses"]) counts[c] = await count(c);
  console.log(`القاعدة: ${mongoose.connection.name}`);
  console.log("== ما سيتغيّر / الحالة ==");
  console.log({
    series: plan.series,
    "supplier_entries (تُشتق حقولها الأصلية)": plan.entries.length,
    "supplier_invoices (تُشتق حقولها الأصلية)": plan.invoices.length,
    "allocations: آمنة/تُعاد حتمياً/تحتاج مراجعة": [plan.allocations.fixable.length, plan.allocations.direct.length, plan.allocations.review.length],
    "settlements: آمنة/تحتاج مراجعة": [plan.settlements.fixable.length, plan.settlements.review.length],
    collections: counts,
  });
  console.log("== مطابقة يدوية (لا يُرحَّل شيء منها تلقائياً) ==");
  console.log(plan.reconciliation);
  if (plan.allocations.review.length || plan.settlements.review.length) console.log("بحاجة مراجعة:", [...plan.allocations.review, ...plan.settlements.review]);
  if (plan.series.consignmentWithoutPrice) console.log(`أرتال أمانة بلا سعر اتفاق: ${plan.series.consignmentWithoutPrice} (لا يُخترع سعر)`);

  if (args.has("--rollback")) {
    const hasData = plan.series.consignment > 0 || Object.values(counts).some((n) => n > 0);
    if (hasData) throw new Error("رفض التراجع: توجد بيانات تجار/أمانة/نقد/مصروفات. التراجع لا يحذف بيانات مالية؛ أرشفها يدوياً أولاً.");
    if (!args.has("--apply")) { console.log("تجربة جافة للتراجع: سيُزال supplier/ownership/consignment من الأرتال فقط. أضف --apply للتنفيذ."); return; }
    const r = await C("series").updateMany({}, { $unset: { supplier: "", ownership: "", consignment: "" } });
    console.log(`تم التراجع: ${r.modifiedCount} رتل.`);
    return;
  }

  if (!args.has("--apply")) {
    console.log("\nتجربة جافة: لم يُكتب شيء. أضف --apply للتنفيذ (يُنشأ نسخ احتياطي أولاً).");
    return;
  }

  // نسخة احتياطية قبل أي كتابة (EJSON) للمجموعات التي ستتأثر
  const { EJSON } = require("bson");
  const dir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = {
    series: await list("series", {}, { seriesNo: 1, ownership: 1, supplier: 1, consignment: 1, "sizes.size": 1, "sizes.settledQty": 1 }),
    supplier_entries: [...entriesAll.values()], supplier_invoices: [...invoicesAll.values()],
    supplier_allocations: await list("supplier_allocations"), supplier_settlements: await list("supplier_settlements"),
  };
  const file = path.join(dir, `pre-suppliers-${stamp}.json`);
  fs.writeFileSync(file, EJSON.stringify(backup, null, 0));
  console.log(`نسخة احتياطية: ${file}`);

  const own = await C("series").updateMany({ ownership: { $exists: false } }, { $set: { ownership: "owned" } });
  console.log(`ownership="owned": ${own.modifiedCount} رتل.`);

  for (const e of plan.entries) {
    const amountMinor = e.amountMinor ?? toMinorC(e.currency, e.amount);
    const signedMinor = e.signedMinor ?? sign(e) * amountMinor;
    const set = { amountMinor, signedMinor };
    if (e.valuationUsdMinor == null && e.currency === "USD") set.valuationUsdMinor = amountMinor;
    else if (e.valuationUsdMinor == null && e.currency === "SYP" && e.rate > 0 && e.usdMinor != null) set.valuationUsdMinor = e.usdMinor; // توثيق تاريخي فقط
    await C("supplier_entries").updateOne({ _id: e._id }, { $set: set });
  }
  for (const i of plan.invoices) await C("supplier_invoices").updateOne({ _id: i._id }, { $set: { amountMinor: toMinorC(i.currency, i.amount) } });
  console.log(`حقول أصلية: ${plan.entries.length} قيد، ${plan.invoices.length} فاتورة.`);

  for (const a of plan.allocations.fixable) {
    const inv = invoicesAll.get(String(a.invoice));
    await C("supplier_allocations").updateOne({ _id: a._id }, { $set: { currency: inv.currency, creditCurrency: "USD", creditMinor: a.amountMinor } });
  }
  for (const { a, ent } of plan.allocations.direct) {
    const m = ent.amountMinor ?? toMinorC(ent.currency, ent.amount);
    await C("supplier_allocations").updateOne({ _id: a._id }, { $set: { currency: ent.currency, amountMinor: m, creditCurrency: ent.currency, creditMinor: m } });
  }
  for (const r of plan.allocations.review) await C("supplier_allocations").updateOne({ ref: r.ref }, { $set: { needsReview: true } });
  for (const s of plan.settlements.fixable) {
    const items = s.items.map((i) => ({ ...i, lineMinor: toMinorC("USD", i.lineAmount ?? i.qty * i.unitAmount) }));
    await C("supplier_settlements").updateOne({ _id: s._id }, { $set: { currency: "USD", items, totalMinor: items.reduce((n, i) => n + i.lineMinor, 0) } });
  }
  console.log(`تخصيصات: ${plan.allocations.fixable.length + plan.allocations.direct.length} رُحِّلت، ${plan.allocations.review.length} للمراجعة. تسويات: ${plan.settlements.fixable.length} رُحِّلت، ${plan.settlements.review.length} للمراجعة.`);

  const reportFile = path.join(dir, `finance-reconciliation-${stamp}.json`);
  const unpriced = await list("series", { ownership: "consignment", "consignment.price.amount": { $exists: false } }, { seriesNo: 1, modelNumber: 1, supplier: 1, location: 1, sizes: 1 });
  fs.writeFileSync(reportFile, EJSON.stringify({
    note: "عناصر تحتاج مراجعة يدوية. لم يُنشأ أي رصيد افتتاحي ولا حركة نقد تاريخية ولم يُخمَّن أي سعر أو عملة أو تصنيف.",
    cash: plan.reconciliation,
    customerInvoicesWithoutCash: invNoCash.map((i) => ({ number: i.number, currency: i.currency, cash: i.cashDue ?? i.totalPaid })),
    customerRefundsWithoutCash: retNoCash.map((r) => ({ number: r.number, currency: r.currency, cash: r.cashRefund })),
    supplierPaymentsWithoutCash: supNoCash.map((e) => ({ ref: e.ref, currency: e.currency, amount: e.amount, type: e.type })),
    allocationsNeedingReview: plan.allocations.review, settlementsNeedingReview: plan.settlements.review,
    consignmentSeriesWithoutPrice: unpriced.map((s) => ({ seriesNo: s.seriesNo, modelNumber: s.modelNumber, supplier: s.supplier, location: s.location, remaining: (s.sizes || []).reduce((n, x) => n + x.qty, 0) })),
  }, null, 2));
  console.log(`تقرير المطابقة: ${reportFile}`);

  // فهارس وقيود كل نماذج المشروع (القاعدة المُعاد بناؤها تحتاجها كلها، لا نماذج التجار فقط)
  const modelsDir = path.join(__dirname, "..", "src", "models");
  for (const f of fs.readdirSync(modelsDir).filter((x) => x.endsWith(".model.js"))) {
    const model = require(path.join(modelsDir, f));
    await model.createCollection().catch(() => {});
    await model.syncIndexes();
  }
  console.log("الفهارس جاهزة. الترحيل مكتمل ويمكن إعادة تشغيله بأمان.");
}

main()
  .catch((err) => { console.error("فشل:", err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
