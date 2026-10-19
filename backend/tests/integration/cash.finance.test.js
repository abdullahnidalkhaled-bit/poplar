/*
 * الصندوقان المستقلان (ليرة / دولار) والمالية. تُشغَّل بـ:
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_cash" بالكامل (اسمها يجب أن يحوي test). تعمل على standalone وعلى Replica Set.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_cash$2") : RAW;
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const suite = (name, fn) => test(name, { skip }, fn);

let mongoose, server, base, admin, emp;
const call = async (s, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(s ? { Cookie: s.cookie, "x-csrf-token": s.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const login = async (username, password) => {
  const res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: username, password }) });
  return { cookie: res.headers.getSetCookie().find((c) => c.startsWith("poplar_sid=")).split(";")[0], csrf: (await res.json()).csrfToken };
};
const A = (m, p, b) => call(admin, m, p, b);
const key = () => crypto.randomUUID();
const today = () => new Date().toISOString();
const ser = (...pairs) => ({ sizes: pairs.map(([size, qty]) => ({ size, qty })) });

let n = 0;
const range = () => `from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5).toISOString())}`;
const dash = async () => (await A("GET", `/finance/dashboard?${range()}`)).json;
const bal = async () => { const d = await dash(); return { USD: d.USD.balance, SYP: d.SYP.balance }; };
const newSupplier = async () => (await A("POST", "/suppliers", { name: `تاجر نقد ${++n}`, phone: `0911000${String(n).padStart(3, "0")}` })).json;
const invoice = (id, amount, currency, extra = {}) => A("POST", `/suppliers/${id}/invoices`, { invoiceNo: `C-${++n}`, invoiceDate: today(), amount, currency, idempotencyKey: key(), ...extra });
const pay = (id, amount, currency, extra = {}) => A("POST", `/suppliers/${id}/payments`, { amount, currency, idempotencyKey: key(), ...extra });
const advance = (id, amount, currency, extra = {}) => A("POST", `/suppliers/${id}/advances`, { amount, currency, idempotencyKey: key(), ...extra });
const mkModel = (mn, cost = 10, sell = 30) => A("POST", "/models", { modelNumber: mn, name: `Tee ${mn}`, brand: "TST", origin: "local", type: "قميص", costPrice: cost, sellPrice: sell, sizes: [{ size: "M" }] });
const receive = (mn, qty) => A("POST", "/stock/receive", { modelNumber: mn, location: "shop", idempotencyKey: key(), series: Array.from({ length: Math.ceil(qty / 2) }, (_, i) => ser(["M", i === Math.ceil(qty / 2) - 1 && qty % 2 ? 1 : 2])) });
const sell = async (s, mn, qty, unitPrice, currency) => {
  const m = (await A("GET", `/models/${mn}`)).json;
  return call(s, "POST", "/invoices", { items: [{ modelId: m.id, sizeId: m.sizes[0].id, qty, unitPrice }], currency });
};
const cashList = async (q = "") => (await A("GET", `/finance/cash?limit=100${q}`)).json.items;

test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  const names = ["productModel", "movement", "invoice", "return", "shipment", "counter", "setting", "series", "user", "session", "supplier", "supplierInvoice", "supplierEntry", "supplierReturn", "supplierAllocation", "supplierSettlement", "cashMovement", "expense"];
  await Promise.all(names.map((m) => require(`../../src/models/${m}.model`)).map((m) => m.init?.()));
  const { createApp } = require("../../src/app");
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const { hashPassword } = require("../../src/utils/password");
  await require("../../src/models/user.model").create({ name: "المالك", username: "cash-owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  admin = await login("cash-owner", "Owner-Test-Pass1");
  await A("PUT", "/settings", { usdToSyp: 10000 });
  assert.equal((await A("POST", "/users", { name: "كاشير", username: "cash-clerk", password: "Clerk-Test-Pass1" })).status, 201);
  emp = await login("cash-clerk", "Clerk-Test-Pass1");
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

// ------------------------------------------------------------------------------------------------ الصلاحيات
suite("المالية للمالك فقط: الموظف 403 على كل المسارات ولو كان هو من باع", async () => {
  for (const [m, p, b] of [["GET", `/finance/dashboard?${range()}`], ["GET", "/finance/cash"], ["POST", "/finance/cash", { currency: "USD", direction: "in", amount: 1, note: "x", idempotencyKey: key() }], ["GET", "/finance/expenses"], ["POST", "/finance/expenses", { currency: "USD", amount: 1, category: "x", idempotencyKey: key() }]]) {
    assert.equal((await call(emp, m, p, b)).status, 403, `${m} ${p}`);
    assert.equal((await call(null, m, p, b)).status, 401);
  }
  const { PERMISSIONS, GRANTABLE } = require("../../src/config/permissions");
  assert.ok(PERMISSIONS.includes("finance.manage") && !GRANTABLE.includes("finance.manage"));
});

// ------------------------------------------------------------------------------------------------ بيع نقدي
suite("بيع بالدولار يدخل صندوق الدولار فقط، وبيع بالليرة يدخل صندوق الليرة فقط، ولا مجموع مشترك", async () => {
  await mkModel("CSH-001", 10, 30);
  await receive("CSH-001", 6);
  const b0 = await bal();
  const s1 = await sell(emp, "CSH-001", 2, 30, "USD"); // الموظف يبيع، والنقد يُسجَّل
  assert.equal(s1.status, 201, JSON.stringify(s1.json));
  assert.deepEqual(await bal(), { USD: b0.USD + 60, SYP: b0.SYP });
  const s2 = await sell(emp, "CSH-001", 1, 450000, "SYP");
  assert.equal(s2.status, 201);
  assert.deepEqual(await bal(), { USD: b0.USD + 60, SYP: b0.SYP + 450000 });
  const rows = await cashList();
  assert.ok(rows.filter((r) => r.type === "sale_receipt").every((r) => (r.currency === "USD" ? [60] : [450000]).includes(r.amount)));
  // الاستجابة بقسمين مستقلين فقط
  const d = await dash();
  assert.deepEqual(Object.keys(d).sort(), ["SYP", "USD", "period"]);
  const text = JSON.stringify(d);
  for (const bad of ["combined", "grandTotal", "totalAll", "balanceUsdEquivalent"]) assert.ok(!text.includes(bad), bad);
  assert.equal(d.USD.currency, "USD");
  assert.equal(d.SYP.currency, "SYP");
});

suite("إلغاء الفاتورة يعكس حركة نقدها بنفس العملة مرة واحدة، والتكرار لا يفسد الرصيد", async () => {
  const before = await bal();
  const sale = (await sell(emp, "CSH-001", 1, 300000, "SYP")).json;
  assert.deepEqual(await bal(), { USD: before.USD, SYP: before.SYP + 300000 });
  const c1 = await A("POST", `/invoices/${sale._id || sale.id}/cancel`, {});
  assert.equal(c1.status, 200);
  assert.deepEqual(await bal(), before);
  const c2 = await A("POST", `/invoices/${sale._id || sale.id}/cancel`, {});
  assert.equal(c2.status, 409);
  assert.deepEqual(await bal(), before, "لا حركة ثانية");
  const rows = (await cashList("&currency=SYP")).filter((r) => r.source.ref === `INV-${sale.number}`);
  assert.deepEqual(rows.map((r) => [r.type, r.direction, r.amount]).sort(), [["sale_cancellation", "out", 300000], ["sale_receipt", "in", 300000]].sort());
});

suite("المرتجع النقدي يخرج من صندوق عملة الفاتورة فقط، والتبديل بعملة مختلفة مرفوض", async () => {
  const sale = (await sell(emp, "CSH-001", 1, 30, "USD")).json;
  const b = await bal();
  const ret = await A("POST", "/returns", { invoiceId: sale._id || sale.id, items: [{ itemIndex: 0, qty: 1, condition: "good" }], mode: "cash" });
  assert.equal(ret.status, 201, JSON.stringify(ret.json));
  assert.deepEqual(await bal(), { USD: b.USD - 30, SYP: b.SYP });
  // تبديل بعملة مختلفة: لا تحويل صامت
  const sale2 = (await sell(emp, "CSH-001", 1, 30, "USD")).json;
  const m = (await A("GET", "/models/CSH-001")).json;
  const bad = await A("POST", "/returns", { invoiceId: sale2._id || sale2.id, items: [{ itemIndex: 0, qty: 1, condition: "good" }], mode: "exchange", newInvoice: { currency: "SYP", items: [{ modelId: m.id, sizeId: m.sizes[0].id, qty: 1, unitPrice: 300000 }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "EXCHANGE_CURRENCY_MISMATCH");
  // تبديل بنفس العملة: النقد = الفرق فقط
  const b2 = await bal();
  const ex = await A("POST", "/returns", { invoiceId: sale2._id || sale2.id, items: [{ itemIndex: 0, qty: 1, condition: "good" }], mode: "exchange", newInvoice: { currency: "USD", items: [{ modelId: m.id, sizeId: m.sizes[0].id, qty: 1, unitPrice: 40 }] } });
  assert.equal(ex.status, 201, JSON.stringify(ex.json));
  assert.deepEqual(await bal(), { USD: b2.USD + 10, SYP: b2.SYP }, "الائتمان 30 غير نقدي؛ يدخل الفرق 10 فقط");
});

// ------------------------------------------------------------------------------------------------ الموردون
suite("فاتورة المورد لا تحرك النقد؛ الدفع يخرج من صندوق عملته؛ الليرة لا تمس الدولار", async () => {
  const s = await newSupplier();
  const b0 = await bal();
  const invU = await invoice(s.id, 100, "USD");
  const invS = await invoice(s.id, 1000000, "SYP");
  assert.deepEqual(await bal(), b0, "الفواتير لا تحرك النقد");
  assert.equal((await pay(s.id, 40, "USD", { invoiceId: invU.json.invoice.id })).status, 201);
  assert.deepEqual(await bal(), { USD: b0.USD - 40, SYP: b0.SYP });
  assert.equal((await pay(s.id, 300000, "SYP", { invoiceId: invS.json.invoice.id })).status, 201);
  assert.deepEqual(await bal(), { USD: b0.USD - 40, SYP: b0.SYP - 300000 });
  // حساب المورد بكل عملة مستقل
  const acc = (await A("GET", `/suppliers/${s.id}`)).json.positions;
  assert.deepEqual([acc.USD.grossPayable, acc.SYP.grossPayable], [60, 700000]);
});

suite("السلفة تُخرج النقد عند دفعها فقط، وتخصيصها على فاتورة لا ينشئ حركة نقد ثانية", async () => {
  const s = await newSupplier();
  const b0 = await bal();
  const adv = await advance(s.id, 500000, "SYP");
  assert.deepEqual(await bal(), { USD: b0.USD, SYP: b0.SYP - 500000 });
  const countBefore = (await cashList()).length;
  const inv = await invoice(s.id, 300000, "SYP");
  assert.equal((await A("POST", `/suppliers/${s.id}/allocations`, { entryId: adv.json.entry.id, invoiceId: inv.json.invoice.id, amount: 300000, idempotencyKey: key() })).status, 201);
  assert.equal((await cashList()).length, countBefore, "التخصيص لا حركة نقد");
  assert.deepEqual(await bal(), { USD: b0.USD, SYP: b0.SYP - 500000 });
  // عكس السلفة يعيد النقد ويحرّر تخصيصها
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${adv.json.entry.id}/reverse`, { reason: "خطأ" })).status, 201);
  assert.deepEqual(await bal(), b0);
  const pos = (await A("GET", `/suppliers/${s.id}`)).json.positions.SYP;
  assert.deepEqual([pos.grossPayable, pos.advance], [300000, 0]);
});

suite("الإشعارات الدائنة وائتمان الإرجاع والتسويات لا تحرك النقد", async () => {
  const s = await newSupplier();
  const b0 = await bal();
  const inv = await invoice(s.id, 100, "USD");
  await A("POST", `/suppliers/${s.id}/adjustments`, { kind: "credit", amount: 10, currency: "USD", invoiceId: inv.json.invoice.id, note: "خصم", idempotencyKey: key() });
  await A("POST", `/suppliers/${s.id}/adjustments`, { kind: "adjustment", amount: 5, currency: "USD", note: "رسوم", idempotencyKey: key() });
  assert.deepEqual(await bal(), b0);
});

suite("دفع بعملة تختلف عن الفاتورة: لا يتم إلا بتأكيد صريح ومبلغ تسوية وسعر صرف مُدخَل، ويخرج من صندوق عملة الدفع فقط", async () => {
  const s = await newSupplier();
  const inv = (await invoice(s.id, 20, "USD")).json.invoice;
  const b0 = await bal();
  const none = await pay(s.id, 200000, "SYP", { invoiceId: inv.id });
  assert.equal(none.status, 409);
  assert.equal(none.json.code, "CROSS_CURRENCY_CONFIRM_REQUIRED");
  assert.deepEqual(await bal(), b0);
  // مبلغان وسعر صرف غير متسقين
  const bad = await pay(s.id, 200000, "SYP", { invoiceId: inv.id, crossCurrency: { settlesAmount: 25, rate: 10000 } });
  assert.equal(bad.json.code, "RATE_AMOUNT_MISMATCH");
  const ok = await pay(s.id, 200000, "SYP", { invoiceId: inv.id, crossCurrency: { settlesAmount: 20, rate: 10000 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual(await bal(), { USD: b0.USD, SYP: b0.SYP - 200000 }, "ليرة فقط");
  assert.deepEqual([ok.json.entry.currency, ok.json.entry.amount, ok.json.entry.crossCurrency.invoiceCurrency, ok.json.entry.crossCurrency.settles, ok.json.entry.crossCurrency.rate], ["SYP", 200000, "USD", 20, 10000]);
  const row = (await A("GET", `/suppliers/${s.id}/invoices`)).json.items[0];
  assert.deepEqual([row.currency, row.outstanding, row.payStatus], ["USD", 0, "paid"]);
  const al = (await A("GET", `/suppliers/${s.id}/allocations`)).json.items[0];
  assert.deepEqual([al.currency, al.amount, al.creditCurrency, al.creditAmount, al.crossCurrency, al.rate], ["USD", 20, "SYP", 200000, true, 10000]);
  // الإشعارات الدائنة لا تُربط عبر العملتين
  const s2 = await newSupplier();
  const i2 = (await invoice(s2.id, 20, "USD")).json.invoice;
  assert.equal((await A("POST", `/suppliers/${s2.id}/adjustments`, { kind: "credit", amount: 100000, currency: "SYP", invoiceId: i2.id, note: "x", idempotencyKey: key() })).json.code, "CROSS_CURRENCY_NOT_ALLOWED");
  // تخصيص سلفة بالدولار على فاتورة بالليرة: صراحةً فقط
  const adv = (await advance(s2.id, 30, "USD")).json.entry;
  const iS = (await invoice(s2.id, 600000, "SYP")).json.invoice;
  assert.equal((await A("POST", `/suppliers/${s2.id}/allocations`, { entryId: adv.id, invoiceId: iS.id, amount: 300000, idempotencyKey: key() })).json.code, "CROSS_CURRENCY_CONFIRM_REQUIRED");
  const b1 = await bal();
  assert.equal((await A("POST", `/suppliers/${s2.id}/allocations`, { entryId: adv.id, invoiceId: iS.id, amount: 300000, creditAmount: 30, rate: 10000, crossCurrency: true, idempotencyKey: key() })).status, 201);
  assert.deepEqual(await bal(), b1, "التخصيص لا حركة نقد");
  const p = (await A("GET", `/suppliers/${s2.id}`)).json.positions;
  assert.deepEqual([p.SYP.grossPayable, p.USD.advance, p.USD.grossPayable], [300000, 0, 20]);
});

suite("تكرار طلبات الدفع بنفس المفتاح لا ينشئ حركة نقد ثانية، والطلبات المتوازية تحفظ الرصيد", async () => {
  const s = await newSupplier();
  const b0 = await bal();
  const k = key();
  const r = await Promise.all([1, 2, 3, 4, 5].map(() => A("POST", `/suppliers/${s.id}/payments`, { amount: 10, currency: "USD", idempotencyKey: k })));
  assert.ok(r.every((x) => [200, 201].includes(x.status)));
  assert.deepEqual(await bal(), { USD: b0.USD - 10, SYP: b0.SYP }, "حركة واحدة فقط");
  // دفعات مختلفة متوازية: كلها تُحسب بدقة
  const b1 = await bal();
  const many = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => A("POST", `/suppliers/${s.id}/payments`, { amount: 1000 * i, currency: "SYP", idempotencyKey: key() })));
  assert.ok(many.every((x) => x.status === 201));
  assert.deepEqual(await bal(), { USD: b1.USD, SYP: b1.SYP - 21000 });
});

// ------------------------------------------------------------------------------------------------ مصروفات وحركات يدوية
suite("المصروفات والإيداع/السحب اليدوي تؤثر على صندوق عملتها فقط، وتُعكس دون تكرار", async () => {
  const b0 = await bal();
  const k = key();
  const e1 = await A("POST", "/finance/expenses", { currency: "SYP", amount: 75000, category: "كهرباء", description: "فاتورة", idempotencyKey: k });
  assert.equal(e1.status, 201);
  assert.equal((await A("POST", "/finance/expenses", { currency: "SYP", amount: 75000, category: "كهرباء", idempotencyKey: k })).json.duplicate, true);
  assert.deepEqual(await bal(), { USD: b0.USD, SYP: b0.SYP - 75000 });
  const e2 = await A("POST", "/finance/expenses", { currency: "USD", amount: 5.5, category: "نقل", idempotencyKey: key() });
  assert.deepEqual(await bal(), { USD: b0.USD - 5.5, SYP: b0.SYP - 75000 });
  // دقة العملات
  assert.equal((await A("POST", "/finance/expenses", { currency: "SYP", amount: 100.5, category: "x", idempotencyKey: key() })).json.code, "INVALID_AMOUNT_PRECISION");
  assert.equal((await A("POST", "/finance/expenses", { currency: "USD", amount: 1.234, category: "x", idempotencyKey: key() })).json.code, "INVALID_AMOUNT_PRECISION");
  // عكس المصروف
  assert.equal((await A("POST", `/finance/expenses/${e1.json.expense.id}/reverse`, { reason: "خطأ إدخال" })).status, 201);
  assert.deepEqual(await bal(), { USD: b0.USD - 5.5, SYP: b0.SYP });
  assert.equal((await A("POST", `/finance/expenses/${e1.json.expense.id}/reverse`, { reason: "ثانية" })).json.code, "ALREADY_REVERSED");
  assert.deepEqual(await bal(), { USD: b0.USD - 5.5, SYP: b0.SYP });
  void e2;
  // إيداع/سحب يدوي (رصيد افتتاحي) وعكسه
  const dep = await A("POST", "/finance/cash", { currency: "USD", direction: "in", amount: 1000, note: "رصيد افتتاحي", idempotencyKey: key() });
  assert.equal(dep.status, 201);
  assert.deepEqual(await bal(), { USD: b0.USD - 5.5 + 1000, SYP: b0.SYP });
  assert.equal((await A("POST", `/finance/cash/${dep.json.movement.id}/reverse`, { reason: "تصحيح" })).status, 201);
  assert.deepEqual(await bal(), { USD: b0.USD - 5.5, SYP: b0.SYP });
  // الحركات المرتبطة بمصدر لا تُعكس يدوياً من هنا
  const sale = (await cashList("&type=sale_receipt"))[0];
  assert.equal((await A("POST", `/finance/cash/${sale.id}/reverse`, { reason: "x" })).json.code, "CASH_REVERSE_VIA_SOURCE");
});

// ------------------------------------------------------------------------------------------------ لوحة المالية
suite("اللوحة: أقسام منفصلة، تعريفات الإيراد/الربح/المصروف، وتطابق الأرصدة مع الحركات", async () => {
  await mkModel("CSH-002", 8, 25);
  await receive("CSH-002", 4);
  const d0 = await dash();
  const sU = (await sell(emp, "CSH-002", 2, 25, "USD")).json; // إيراد 50، تكلفة 16
  await sell(emp, "CSH-002", 1, 400000, "SYP");               // إيراد 400000 ل.س
  await A("POST", "/returns", { invoiceId: sU._id || sU.id, items: [{ itemIndex: 0, qty: 1, condition: "good" }], mode: "cash" }); // إرجاع 25 وعودة تكلفة 8
  await A("POST", "/finance/expenses", { currency: "USD", amount: 4, category: "تغليف", idempotencyKey: key() });
  const d = await dash();
  const dU = (k) => Math.round((d.USD[k] - d0.USD[k]) * 100) / 100;
  const dS = (k) => d.SYP[k] - d0.SYP[k];
  assert.equal(dU("revenue"), 50);
  assert.equal(dU("refunds"), 25);
  assert.equal(dU("netRevenue"), 25);
  assert.equal(dU("cogs"), 8, "تكلفة 16 − تكلفة المرتجع السليم 8");
  assert.equal(dU("grossProfit"), 17);
  assert.equal(dU("expenses"), 4);
  assert.equal(dU("netProfit"), 13);
  // الليرة: إيراد حقيقي، وربح غير متاح (تكلفة بالدولار) مع تقدير منفصل مُعلَّم
  assert.equal(dS("revenue"), 400000);
  assert.equal(d.SYP.cogs, null);
  assert.equal(d.SYP.grossProfit, null);
  assert.equal(d.SYP.netProfit, null);
  assert.ok(d.SYP.unavailable && d.SYP.estimate && Number.isInteger(d.SYP.estimate.cogs));
  assert.equal(d.USD.customerReceivables.supported, false);
  // الرصيد من مجموع الحركات تماماً لكل عملة
  const all = [];
  for (let page = 1; ; page++) { const r = (await A("GET", `/finance/cash?limit=100&page=${page}`)).json; all.push(...r.items); if (page >= r.pages) break; }
  for (const c of ["USD", "SYP"]) {
    const sum = all.filter((m) => m.currency === c).reduce((x, m) => x + (m.direction === "in" ? 1 : -1) * Math.round(m.amount * (c === "USD" ? 100 : 1)), 0);
    assert.equal(sum, Math.round(d[c].balance * (c === "USD" ? 100 : 1)), `${c}: الرصيد = مجموع الحركات`);
  }
  // الفترة: خارج الفترة لا شيء؛ المقارنة السابقة موجودة
  const empty = (await A("GET", `/finance/dashboard?from=${encodeURIComponent("2000-01-01T00:00:00Z")}&to=${encodeURIComponent("2000-02-01T00:00:00Z")}`)).json;
  assert.equal(empty.USD.revenue, 0);
  assert.equal(empty.USD.balance, d.USD.balance, "الرصيد الحالي مستقل عن الفترة");
  assert.ok(d.USD.previous && "netRevenue" in d.USD.previous);
  assert.ok(Array.isArray(d.USD.daily) && d.USD.daily.length >= 1);
  // إدخال فترة غير صالحة
  assert.equal((await A("GET", `/finance/dashboard?from=${encodeURIComponent("2026-02-01T00:00:00Z")}&to=${encodeURIComponent("2026-01-01T00:00:00Z")}`)).json.code, "INVALID_RANGE");
});

suite("فواتير تاريخية بلا حركات نقد تُبلَّغ للمطابقة اليدوية ولا تُرحَّل تلقائياً", async () => {
  const Invoice = require("../../src/models/invoice.model");
  const before = (await dash()).USD.legacy.invoicesWithoutCash;
  await Invoice.collection.insertOne({ number: 9000001, currency: "USD", rate: 0, items: [{ qty: 1, unitPrice: 5, costPrice: 1 }], itemsCount: 1, totalPaid: 5, cashDue: 5, totalUsd: 5, costUsd: 1, profitUsd: 4, status: "completed", createdAt: new Date(), updatedAt: new Date() });
  const d = await dash();
  assert.equal(d.USD.legacy.invoicesWithoutCash, before + 1);
  assert.equal((await mongoose.connection.collection("cash_movements").countDocuments({ "source.ref": "INV-9000001" })), 0, "لا ترحيل تلقائي");
});
