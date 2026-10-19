/*
 * اختبارات تكاملية على MongoDB حقيقي. تُشغَّل بـ:
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تحذير: تُفرَّغ قاعدة الاختبار بالكامل. يجب أن يحتوي اسمها على كلمة "test" (حماية من مسح بيانات حقيقية).
 * يُفضَّل Replica Set لاختبار مسار Transactions أيضاً، وتعمل بدونه بمسار التراجع التعويضي.
 */
process.env.NODE_ENV = "test";
const URI = process.env.MONGO_TEST_URI;
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const suite = (name, fn) => test(name, { skip }, fn);

let mongoose, server, base, session;
const api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Cookie: session.cookie, "x-csrf-token": session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const key = () => crypto.randomUUID();
const sizeOf = (m, s) => m.sizes.find((x) => x.size === s);
const ser = (...pairs) => ({ sizes: pairs.map(([size, qty]) => ({ size, qty })) });
const receive = (modelNumber, location, series, extra = {}) => api("POST", "/stock/receive", { modelNumber, location, idempotencyKey: key(), series, ...extra });
const seriesOf = async (q, extra = "") => (await api("GET", `/series?q=${encodeURIComponent(q)}&limit=100${extra}`)).json.items;
const model = async (mn) => (await api("GET", `/models/${mn}`)).json;

test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  const models = ["productModel", "movement", "invoice", "return", "shipment", "counter", "setting", "series", "user", "session"].map((m) => require(`../../src/models/${m}.model`));
  await Promise.all(models.map((m) => (m.init ? m.init() : m.Counter?.init?.())));
  const { createApp } = require("../../src/app");
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  // كل الاختبارات هنا تعمل كمالك مسجَّل الدخول (المصادقة والصلاحيات لها ملفها: auth.rbac.test.js)
  const { hashPassword } = require("../../src/utils/password");
  const pw = "Flow-Test-Pass-1";
  await require("../../src/models/user.model").create({ name: "مالك", username: "flow-owner", passwordHash: await hashPassword(pw), role: "admin" });
  const res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: "flow-owner", password: pw }) });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("poplar_sid=")).split(";")[0];
  session = { cookie, csrf: (await res.json()).csrfToken };
  await api("PUT", "/settings", { usdToSyp: 14000 });
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

const newModel = (extra = {}) => ({
  name: "FAF Bootcut Trousers", brand: "FAF", origin: "local", type: "بنطال", cut: "بوت كات", costPrice: 22, sellPrice: 45,
  sizes: ["S", "M", "L", "XL"].map((size) => ({ size })), ...extra,
});

suite("إنشاء موديل برقم فريد ورفض التكرار", async () => {
  const a = await api("POST", "/models", newModel({ modelNumber: "FAF-001" }));
  assert.equal(a.status, 201);
  assert.equal(a.json.modelNumber, "FAF-001");
  assert.equal(a.json.sizes.length, 4, "كل المقاسات تظهر حتى الصفرية");
  assert.equal(a.json.totals.combined, 0);
  const dup = await api("POST", "/models", newModel({ modelNumber: "faf-001", name: "Other" }));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, "MODEL_NUMBER_TAKEN");
  const auto = await api("POST", "/models", newModel({ name: "FAF Skinny", cut: "سكيني" }));
  assert.match(auto.json.modelNumber, /^FAF-\d{3}$/);
});

suite("استلام أرتال متعددة لنفس الموديل: تجميع، موقع صحيح، سجل قبل/بعد وتوزيع، ومنع التكرار", async () => {
  await api("POST", "/models", newModel({ modelNumber: "SER-M1", brand: "Ser", sizes: ["XS", "S", "M", "L"].map((size) => ({ size })) }));
  const k = key();
  const body = {
    modelNumber: "SER-M1", location: "warehouse", idempotencyKey: k, unitCostUsd: 22,
    series: [ser(["XS", 1], ["S", 2], ["M", 1]), ser(["XS", 2], ["M", 1], ["L", 2])], // XS إجماليه 3 عبر رتلين: مسموح
  };
  const r = await api("POST", "/stock/receive", body);
  assert.equal(r.status, 201);
  assert.equal(r.json.series.length, 2);
  assert.notEqual(r.json.series[0].seriesNo, r.json.series[1].seriesNo);
  assert.ok(r.json.series.every((x) => x.location === "warehouse" && x.kind === "received"));
  assert.deepEqual(r.json.series.map((x) => x.totalPieces), [4, 5]);
  assert.equal(sizeOf(r.json.model, "XS").warehouseQty, 3);
  assert.equal(sizeOf(r.json.model, "XS").shopQty, 0);
  assert.deepEqual(r.json.model.totals, { shop: 0, warehouse: 9, combined: 9 });

  const again = await api("POST", "/stock/receive", body);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.model.totals.combined, 9, "لا مضاعفة عند إعادة الإرسال");
  assert.equal((await seriesOf("SER-M1")).length, 2, "لا أرتال مكررة");

  const log = await api("GET", "/movements?q=SER-M1&type=receive&size=M&dir=asc");
  assert.equal(log.json.items.length, 2, "حركة لكل (رتل، مقاس)");
  assert.deepEqual(log.json.items.map((m) => [m.before.warehouse, m.after.warehouse]), [[0, 1], [1, 2]]);
  assert.equal(log.json.items[0].allocations[0].seriesNo, r.json.series[0].seriesNo);
});

suite("رفض الأرتال غير الصالحة برسائل واضحة ولا شيء يُحفظ", async () => {
  const bad3 = await receive("SER-M1", "warehouse", [ser(["S", 3])]);
  assert.equal(bad3.status, 400);
  assert.equal(bad3.json.code, "VALIDATION_ERROR");
  assert.match(bad3.json.message, /قطعتين/);
  assert.equal((await receive("SER-M1", "warehouse", [{ sizes: [] }])).status, 400);
  assert.equal((await receive("SER-M1", "warehouse", [ser(["S", 0])])).status, 400);
  assert.equal((await receive("SER-M1", "warehouse", [])).status, 400);
  assert.equal((await receive("SER-M1", "warehouse", [ser(["S", 1]), ser(["M", 5])])).status, 400, "رتل واحد فاسد يلغي الشحنة كلها");
  assert.equal((await model("SER-M1")).totals.combined, 9);
  assert.equal((await seriesOf("SER-M1")).length, 2);
});

suite("مقاس مخصص يُضاف تلقائياً، والتكلفة بالمتوسط المرجّح، والرصيد الافتتاحي أرتال", async () => {
  const c = await api("POST", "/models", newModel({
    modelNumber: "FAF-020", sizes: [{ size: "S" }],
    openingSeries: [{ location: "warehouse", sizes: [{ size: "S", qty: 2 }] }, { location: "warehouse", sizes: [{ size: "S", qty: 2 }] }],
  }));
  assert.equal(c.status, 201);
  assert.equal(c.json.totals.warehouse, 4);
  assert.equal((await seriesOf("FAF-020")).length, 2);
  const r = await receive("FAF-020", "warehouse", [ser(["S", 2]), ser(["S", 1], ["3XL", 1])], { unitCostUsd: 26 });
  assert.equal(r.status, 201);
  assert.equal(sizeOf(r.json.model, "3XL").warehouseQty, 1);
  assert.equal(r.json.model.costPrice, 24); // (4*22 + 4*26) / 8
  const badOpening = await api("POST", "/models", newModel({ modelNumber: "FAF-021", openingSeries: [{ location: "shop", sizes: [{ size: "S", qty: 3 }] }] }));
  assert.equal(badOpening.status, 400);
  assert.equal((await api("GET", "/models/FAF-021")).status, 404, "لا موديل نصف منشأ");
});

suite("سجل الأرتال: صف لكل رتل، تفاصيل، بحث، فلترة، ترتيب وترقيم", async () => {
  const all = await api("GET", "/series?limit=100");
  assert.ok(all.json.total >= 4);
  assert.ok(all.json.items.every((s) => Array.isArray(s.sizes) && typeof s.totalPieces === "number" && s.sizeSummary !== undefined));

  const mine = await seriesOf("SER-M1");
  assert.equal(mine.length, 2, "رتلان لا 9 قطع");
  const a = mine.find((s) => s.totalPieces === 4);
  assert.equal(a.sizeSummary, "XS: 1, S: 2, M: 1");
  assert.equal(a.location, "warehouse");

  const d = await api("GET", `/series/${a.seriesNo}`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.json.sizes.map((x) => [x.size, x.qty]), [["M", 1], ["S", 2], ["XS", 1]].sort((p, q) => p[0].localeCompare(q[0], undefined, { numeric: true })));
  assert.equal(d.json.totalPieces, 4);
  assert.equal(d.json.modelNumber, "SER-M1");
  assert.ok(d.json.movements.some((m) => m.type === "receive"));
  assert.equal((await api("GET", "/series/SER-999999")).status, 404);
  assert.equal((await api("GET", "/series/bad")).status, 400);

  assert.equal((await seriesOf(a.seriesNo)).length, 1, "بحث برقم الرتل");
  assert.ok((await seriesOf("ser-m1")).length === 2, "بحث برقم الموديل");
  assert.ok((await seriesOf("bootcut")).length >= 2, "بحث بالاسم");
  assert.ok((await seriesOf("", "&location=shop")).every((s) => s.location === "shop"));
  const future = await api("GET", `/series?from=${new Date(Date.now() + 86400000).toISOString()}&to=${new Date(Date.now() + 2 * 86400000).toISOString()}`);
  assert.equal(future.json.total, 0);
  const p1 = await api("GET", "/series?limit=1&page=1&sort=seriesNo&dir=asc");
  const p2 = await api("GET", "/series?limit=1&page=2&sort=seriesNo&dir=asc");
  assert.equal(p1.json.items.length, 1);
  assert.ok(p1.json.pages >= 2 && p1.json.items[0].seriesNo < p2.json.items[0].seriesNo);
});

suite("التوفر والتنبيهات: الحالات A-D عبر الموديل والبحث والـ dashboard", async () => {
  await api("POST", "/models", newModel({
    modelNumber: "FAF-030",
    openingSeries: [{ location: "shop", sizes: [{ size: "S", qty: 1 }, { size: "M", qty: 1 }] }, { location: "warehouse", sizes: [{ size: "M", qty: 1 }, { size: "XL", qty: 1 }] }],
  }));
  const m = await model("FAF-030");
  assert.deepEqual([sizeOf(m, "S").availability, sizeOf(m, "S").needsFactoryRestock, sizeOf(m, "S").canTransfer], ["store_only", false, false], "A: كمية 1 بالمحل لا تنبيه");
  assert.equal(sizeOf(m, "XL").canTransfer, true);                  // B
  assert.equal(sizeOf(m, "XL").needsFactoryRestock, false);
  assert.equal(sizeOf(m, "L").needsFactoryRestock, true);           // C
  assert.equal(sizeOf(m, "M").availability, "both");                // D
  assert.equal(sizeOf(m, "S").lowStock, undefined);
  assert.deepEqual(m.restockSizes, ["L"]);
  assert.deepEqual(m.transferableSizes, ["XL"]);
  assert.deepEqual(m.totals, { shop: 2, warehouse: 2, combined: 4 });

  const viaSearch = (await api("GET", "/models?q=FAF-030")).json.items[0];
  assert.deepEqual(viaSearch.totals, m.totals, "نفس الأرقام عبر البحث");
  assert.ok((await api("GET", "/models?status=transfer")).json.items.some((x) => x.modelNumber === "FAF-030"));
  assert.ok((await api("GET", "/models?status=out")).json.items.some((x) => x.modelNumber === "FAF-030"));
  assert.equal((await api("GET", "/models?status=low")).status, 400, "فلتر المنخفض أُلغي");

  const dash = (await api("GET", "/reports/dashboard")).json;
  const att = dash.attention.find((x) => x.modelNumber === "FAF-030");
  assert.deepEqual(att.restockSizes, ["L"]);
  assert.deepEqual(att.transferSizes, [{ size: "XL", warehouseQty: 1 }]);
  assert.equal(att.lowSizes, undefined);
  assert.ok(dash.totals.combined >= 4 && dash.counts.low === undefined);
});

suite("النقل الجزئي: يحفظ هوية الرتل الأصلي، والإجمالي ثابت، والمنتهي لا يُحذف", async () => {
  await api("POST", "/models", newModel({ modelNumber: "PART-001", brand: "Part", sizes: [{ size: "M" }], openingSeries: [{ location: "warehouse", sizes: [{ size: "M", qty: 2 }] }] }));
  const origin = (await seriesOf("PART-001"))[0];
  const t1 = await api("POST", "/stock/transfer", { modelNumber: "PART-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }] });
  assert.equal(t1.status, 200);
  assert.deepEqual(t1.json.model.totals, { shop: 1, warehouse: 1, combined: 2 });
  let list = await seriesOf("PART-001");
  assert.equal(list.length, 2);
  const derived = list.find((s) => s.kind === "derived");
  assert.equal(derived.location, "shop");
  assert.equal(derived.originSeries, origin.id);
  assert.equal((await api("GET", `/series/${origin.seriesNo}`)).json.sizes[0].qty, 1, "المتبقي في المستودع");

  const t2 = await api("POST", "/stock/transfer", { modelNumber: "PART-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }] });
  assert.equal(t2.status, 200);
  list = await seriesOf("PART-001");
  assert.equal(list.length, 2, "النقلة الثانية تُدمج في الرتل المشتق نفسه");
  const o = list.find((s) => s.id === origin.id);
  assert.equal(o.status, "depleted", "الرتل الفارغ يُعلَّم منتهياً");
  assert.equal(o.totalPieces, 0);
  assert.equal(list.find((s) => s.kind === "derived").totalPieces, 2);
  assert.ok((await seriesOf("PART-001", "&status=depleted")).some((s) => s.id === origin.id), "السجل التاريخي باقٍ");

  const det = (await api("GET", `/series/${origin.seriesNo}`)).json;
  assert.equal(det.derived[0].seriesNo, derived.seriesNo);
  assert.ok(det.movements.filter((m) => m.type === "transfer").length === 2);
  const mv = (await api("GET", `/movements?series=${origin.seriesNo}&type=transfer`)).json.items[0];
  assert.deepEqual(mv.allocations.map((a) => a.location).sort(), ["shop", "warehouse"]);
});

suite("FIFO: يُخصم من الرتل الأقدم أولاً ثم يليه", async () => {
  await api("POST", "/models", newModel({ modelNumber: "FIFO-001", brand: "Fifo", sizes: [{ size: "M" }] }));
  await receive("FIFO-001", "warehouse", [ser(["M", 2])]);
  await receive("FIFO-001", "warehouse", [ser(["M", 2])]);
  const [first, second] = (await seriesOf("FIFO-001", "&sort=receivedAt&dir=asc")).map((s) => s.seriesNo);
  await api("POST", "/stock/transfer", { modelNumber: "FIFO-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 3 }] });
  assert.equal((await api("GET", `/series/${first}`)).json.totalPieces, 0);
  assert.equal((await api("GET", `/series/${first}`)).json.status, "depleted");
  assert.equal((await api("GET", `/series/${second}`)).json.totalPieces, 1);
  const shopSeries = await seriesOf("FIFO-001", "&location=shop");
  assert.equal(shopSeries.length, 2, "مشتق لكل أصل");
  assert.equal(shopSeries.reduce((n, s) => n + s.totalPieces, 0), 3);
});

suite("النقل: يرفض عند عدم كفاية المصدر، ولا يترك أثراً جزئياً عند فشل بند", async () => {
  const bad = await api("POST", "/stock/transfer", { modelNumber: "PART-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }] });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, "INSUFFICIENT_STOCK");

  await api("POST", "/models", newModel({ modelNumber: "ROLL-001", brand: "Roll", sizes: [{ size: "S" }, { size: "M" }], openingSeries: [{ location: "warehouse", sizes: [{ size: "S", qty: 2 }] }] }));
  const before = (await seriesOf("ROLL-001")).length;
  const fail = await api("POST", "/stock/transfer", { modelNumber: "ROLL-001", from: "warehouse", to: "shop", items: [{ size: "S", qty: 1 }, { size: "M", qty: 1 }] });
  assert.equal(fail.status, 409);
  const m = await model("ROLL-001");
  assert.deepEqual(m.totals, { shop: 0, warehouse: 2, combined: 2 }, "البند الأول لم يُنفَّذ");
  assert.equal((await seriesOf("ROLL-001")).length, before, "لا رتل مشتق عالق");
  assert.equal((await api("GET", "/movements?q=ROLL-001&type=transfer")).json.total, 0);
  assert.equal((await api("POST", "/stock/transfer", { modelNumber: "ROLL-001", from: "shop", to: "shop", items: [{ size: "S", qty: 1 }] })).status, 400);
  assert.equal((await api("POST", "/stock/transfer", { modelNumber: "ROLL-001", from: "warehouse", to: "shop", items: [{ size: "XXL", qty: 1 }] })).status, 404);
});

suite("تزامن: 20 نقلاً متوازياً من كمية 10 ينجح منها 10 بالضبط ولا يصير المخزون سالباً", async () => {
  const openings = Array.from({ length: 5 }, () => ({ location: "warehouse", sizes: [{ size: "M", qty: 2 }] }));
  await api("POST", "/models", newModel({ modelNumber: "RACE-001", brand: "Race", sizes: [{ size: "M" }], openingSeries: openings }));
  const results = await Promise.all(Array.from({ length: 20 }, () => api("POST", "/stock/transfer", { modelNumber: "RACE-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 1 }] })));
  assert.equal(results.filter((r) => r.status === 200).length, 10, JSON.stringify(results.filter((r) => r.status !== 200 && r.status !== 409).map((r) => r.json)));
  const m = await model("RACE-001");
  assert.deepEqual(m.totals, { shop: 10, warehouse: 0, combined: 10 });
  const all = await seriesOf("RACE-001");
  assert.ok(all.every((s) => s.sizes.every((x) => x.qty >= 0)));
  assert.equal(all.filter((s) => s.kind === "derived").length, 5, "رتل مشتق واحد لكل أصل رغم التزامن");
});

suite("تزامن البيع: لا بيع زائد عن المتوفر", async () => {
  await api("POST", "/models", newModel({ modelNumber: "SELL-001", brand: "Sell", sizes: [{ size: "M" }], openingSeries: [{ location: "shop", sizes: [{ size: "M", qty: 2 }] }, { location: "shop", sizes: [{ size: "M", qty: 1 }] }] }));
  const m = await model("SELL-001");
  const res = await Promise.all(Array.from({ length: 8 }, () => api("POST", "/invoices", { currency: "USD", items: [{ modelId: m.id, sizeId: sizeOf(m, "M").id, qty: 1, unitPrice: 45 }] })));
  assert.equal(res.filter((r) => r.status === 201).length, 3);
  assert.equal((await model("SELL-001")).totals.combined, 0);
});

suite("تالف وجرد: يسجَّلان، والسالب مرفوض، والزيادة إلى رتل رصيد", async () => {
  const d = await api("POST", "/stock/damage", { modelNumber: "FAF-030", size: "S", qty: 1, location: "shop", reason: "تمزق" });
  assert.equal(d.status, 200);
  assert.equal(sizeOf(d.json.model, "S").shopQty, 0);
  assert.equal(sizeOf(d.json.model, "S").needsFactoryRestock, true, "صفر في الموقعين => اطلب شحنة");
  assert.equal((await api("POST", "/stock/damage", { modelNumber: "FAF-030", size: "S", qty: 1, location: "shop", reason: "x" })).status, 409);
  assert.equal((await api("POST", "/stock/adjust", { modelNumber: "FAF-030", size: "M", location: "shop", newQty: -1, reason: "x" })).status, 400);
  const a = await api("POST", "/stock/adjust", { modelNumber: "FAF-030", size: "M", location: "shop", newQty: 4, reason: "جرد" });
  assert.equal(sizeOf(a.json.model, "M").shopQty, 4);
  assert.ok((await seriesOf("FAF-030")).some((s) => s.kind === "balance" && s.location === "shop"));
  const log = await api("GET", "/movements?q=FAF-030&type=adjust");
  assert.deepEqual([log.json.items[0].before.shop, log.json.items[0].after.shop], [1, 4]);
  const down = await api("POST", "/stock/adjust", { modelNumber: "FAF-030", size: "M", location: "shop", newQty: 3, reason: "جرد" });
  assert.equal(sizeOf(down.json.model, "M").shopQty, 3);
  assert.equal((await api("POST", "/stock/adjust", { modelNumber: "FAF-030", size: "M", location: "shop", newQty: 3, reason: "x" })).json.code, "NO_DIFFERENCE");
});

suite("البيع والإلغاء: FIFO مع توزيع محفوظ، وعودة القطع لرتلها، ولا خصم جزئي عند الفشل", async () => {
  const a = await model("FAF-030");
  const b = await model("SER-M1");
  const line = (m, size, qty) => ({ modelId: m.id, sizeId: sizeOf(m, size).id, qty, unitPrice: 45 });
  const before = sizeOf(a, "M").shopQty;
  const bad = await api("POST", "/invoices", { currency: "USD", items: [line(a, "M", 1), line(b, "L", 5)] }); // L بلا مخزون في المحل
  assert.equal(bad.status, 409);
  assert.equal(sizeOf(await model("FAF-030"), "M").shopQty, before, "لا خصم جزئي");

  const ok = await api("POST", "/invoices", { currency: "USD", items: [line(a, "M", 1)] });
  assert.equal(ok.status, 201);
  const alloc = ok.json.items[0].allocations;
  assert.equal(alloc.reduce((n, x) => n + x.qty, 0), 1);
  assert.equal(sizeOf(await model("FAF-030"), "M").shopQty, before - 1);
  const sale = (await api("GET", `/movements?q=INV-${ok.json.number}`)).json.items[0];
  assert.equal(sale.allocations[0].seriesNo, alloc[0].seriesNo);

  const seriesBefore = (await api("GET", `/series/${alloc[0].seriesNo}`)).json.totalPieces;
  const cancel = await api("POST", `/invoices/${ok.json._id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(sizeOf(await model("FAF-030"), "M").shopQty, before);
  assert.equal((await api("GET", `/series/${alloc[0].seriesNo}`)).json.totalPieces, seriesBefore + 1, "عادت إلى رتلها الأصلي");
});

suite("إرجاع بتغيّر الصرف: يُعكس بقيم البيع الأول، وتعود القطعة لرتلها", async () => {
  await api("POST", "/models", newModel({ modelNumber: "FX-001", brand: "Fx", sizes: [{ size: "M" }], openingSeries: [{ location: "shop", sizes: [{ size: "M", qty: 2 }] }, { location: "shop", sizes: [{ size: "M", qty: 2 }] }, { location: "shop", sizes: [{ size: "M", qty: 1 }] }] }));
  const m = await model("FX-001");
  const inv = await api("POST", "/invoices", { currency: "SYP", items: [{ modelId: m.id, sizeId: sizeOf(m, "M").id, qty: 1, unitPrice: 630000 }] });
  await api("PUT", "/settings", { usdToSyp: 13500 });
  const ret = await api("POST", "/returns", { invoiceId: inv.json._id, mode: "cash", items: [{ itemIndex: 0, qty: 1 }] });
  assert.equal(ret.status, 201);
  assert.equal(ret.json.return.refundAmount, 630000);
  assert.equal(ret.json.return.refundUsd, 45);
  assert.equal(ret.json.return.fxDiffUsd, 1.6667);
  assert.equal(sizeOf(await model("FX-001"), "M").shopQty, 5, "القطعة السليمة عادت للمحل");
  const twice = await api("POST", "/returns", { invoiceId: inv.json._id, mode: "cash", items: [{ itemIndex: 0, qty: 1 }] });
  assert.equal(twice.status, 409, "لا إرجاع مزدوج");
  await api("PUT", "/settings", { usdToSyp: 14000 });
});

suite("فواتير ما قبل الأرتال (بلا توزيع) تُرجع إلى رتل رصيد المحل", async () => {
  const Invoice = require("../../src/models/invoice.model");
  const m = await model("FX-001");
  const inv = await api("POST", "/invoices", { currency: "USD", items: [{ modelId: m.id, sizeId: sizeOf(m, "M").id, qty: 1, unitPrice: 45 }] });
  await Invoice.updateOne({ _id: inv.json._id }, { $unset: { "items.0.allocations": "" } }); // محاكاة فاتورة قديمة
  const cancel = await api("POST", `/invoices/${inv.json._id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(sizeOf(await model("FX-001"), "M").shopQty, 5);
  assert.ok((await seriesOf("FX-001", "&location=shop")).some((s) => s.kind === "balance" && s.totalPieces === 1));
});

suite("سجل الحركات: ترقيم صفحات وفلترة وترتيب", async () => {
  const p1 = await api("GET", "/movements?limit=3&page=1&sort=createdAt&dir=desc");
  assert.equal(p1.json.items.length, 3);
  assert.ok(p1.json.total >= 10 && p1.json.pages >= 2);
  const f = await api("GET", "/movements?type=transfer&location=shop");
  assert.ok(f.json.items.every((x) => x.type === "transfer"));
  const dates = (await api("GET", "/movements?dir=asc&limit=50")).json.items.map((x) => +new Date(x.createdAt));
  assert.deepEqual(dates, [...dates].sort((x, y) => x - y));
});

suite("البحث وQR: رقم الموديل أولاً، ثم الاسم، وأخطاء الموديل المجهول/المؤرشف", async () => {
  const exact = await api("GET", "/models?q=%20faf-001%20");
  assert.equal(exact.json.items[0].modelNumber, "FAF-001");
  assert.equal(exact.json.items[0].matchType, "model_number_exact");
  assert.ok((await api("GET", "/models?q=bootcut")).json.items.some((m) => m.modelNumber === "FAF-001"));
  assert.equal((await api("GET", "/models?q=zzzznothing")).json.items.length, 0);
  const qr = await api("GET", "/models/FAF-001/qr");
  assert.equal(qr.json.payload, "PLP1:FAF-001");
  assert.equal((await api("POST", "/qr/resolve", { payload: "PLP1:NOPE-999" })).json.code, "QR_NOT_FOUND");
  await api("POST", "/models", newModel({ modelNumber: "OLD-001", brand: "Old", sizes: [{ size: "S" }] }));
  await api("DELETE", "/models/OLD-001");
  assert.equal((await api("POST", "/qr/resolve", { payload: "PLP1:OLD-001" })).json.code, "QR_OBSOLETE");
  assert.equal((await receive("OLD-001", "shop", [ser(["S", 1])])).status, 409, "لا استلام على موديل مؤرشف");
});

suite("حذف مقاس: مرفوض إن كان له مخزون، مسموح إن كان فارغاً", async () => {
  assert.equal((await api("PUT", "/models/FAF-030", { removeSizes: ["M"] })).json.code, "SIZE_HAS_STOCK");
  const ok = await api("PUT", "/models/FAF-030", { removeSizes: ["L"] });
  assert.equal(ok.status, 200);
  assert.ok(!sizeOf(ok.json, "L"));
});
