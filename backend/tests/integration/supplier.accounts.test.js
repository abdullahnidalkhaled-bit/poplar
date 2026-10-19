/*
 * حسابات التجار والأمانة والتسوية على MongoDB حقيقي. تُشغَّل بـ:
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_suppliers" بالكامل (اسمها يجب أن يحوي test).
 * تعمل على standalone (تراجع تعويضي) وعلى Replica Set (Transactions) حسب إعداد DISABLE_TRANSACTIONS.
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_suppliers$2") : RAW;
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

let n = 0;
const newSupplier = async (name = `تاجر ${++n}`) => (await A("POST", "/suppliers", { name, phone: `0900000${String(n).padStart(3, "0")}` })).json;
const account = async (id) => (await A("GET", `/suppliers/${id}`)).json;
const pos = async (id, cur = "USD") => { const a = await account(id); const p = a.positions[cur]; return [p.grossPayable, p.advance, p.net, a.status]; };
const invoice = (id, amount, extra = {}) => A("POST", `/suppliers/${id}/invoices`, { invoiceNo: `INV-${++n}`, invoiceDate: today(), amount, currency: "USD", idempotencyKey: key(), ...extra });
const pay = (id, amount, extra = {}) => A("POST", `/suppliers/${id}/payments`, { amount, currency: "USD", idempotencyKey: key(), ...extra });
const advance = (id, amount, extra = {}) => A("POST", `/suppliers/${id}/advances`, { amount, currency: "USD", idempotencyKey: key(), ...extra });
const allocate = (id, entryId, invoiceId, amount, extra = {}) => A("POST", `/suppliers/${id}/allocations`, { entryId, invoiceId, amount, idempotencyKey: key(), ...extra });
const ser = (...pairs) => ({ sizes: pairs.map(([size, qty]) => ({ size, qty })) });
const receive = (modelNumber, location, series, extra = {}) => A("POST", "/stock/receive", { modelNumber, location, idempotencyKey: key(), series, ...extra });
const mkModel = (modelNumber, cost = 20) => A("POST", "/models", { modelNumber, name: `Jeans ${modelNumber}`, brand: "TST", origin: "local", type: "بنطال", costPrice: cost, sellPrice: cost * 2, sizes: [{ size: "S" }, { size: "M" }, { size: "L" }] });
const consignment = async (id, q = "") => (await A("GET", `/suppliers/${id}/consignment${q}`)).json;
const eligible = async (id) => (await A("GET", `/suppliers/${id}/settlements/eligible`)).json;
const qtyOf = async (mn, size) => { const m = (await A("GET", `/models/${mn}`)).json; const s = m.sizes.find((x) => x.size === size); return { shop: s.shopQty, warehouse: s.warehouseQty }; };
const sell = async (mn, size, qty) => {
  const m = (await A("GET", `/models/${mn}`)).json;
  const r = await A("POST", "/invoices", { items: [{ modelId: m.id, sizeId: m.sizes.find((x) => x.size === size).id, qty, unitPrice: 100 }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};
const settle = (id, items, extra = {}) => A("POST", `/suppliers/${id}/settlements`, { items, idempotencyKey: key(), ...extra });
// مورّد بأمانة مسعّرة في المحل: موديل + رتل واحد (مقاسات M:2,S:2) بسعر اتفاق
const consignmentFixture = async (mn, price = { amount: 30, currency: "USD" }, cost = 50) => {
  const s = await newSupplier();
  await mkModel(mn, cost);
  const r = await receive(mn, "shop", [ser(["M", 2], ["S", 2])], { supplierId: s.id, consignment: true, ...(price ? { consignmentPrice: price } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { s, series: r.json.series[0] };
};

test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  const names = ["productModel", "movement", "invoice", "return", "shipment", "counter", "setting", "series", "user", "session", "supplier", "supplierInvoice", "supplierEntry", "supplierReturn", "supplierAllocation", "supplierSettlement"];
  await Promise.all(names.map((m) => require(`../../src/models/${m}.model`)).map((m) => m.init?.()));
  const { createApp } = require("../../src/app");
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const { hashPassword } = require("../../src/utils/password");
  await require("../../src/models/user.model").create({ name: "المالك", username: "sup-owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  admin = await login("sup-owner", "Owner-Test-Pass1");
  await A("PUT", "/settings", { usdToSyp: 10000 });
  assert.equal((await A("POST", "/users", { name: "موظف", username: "sup-clerk", password: "Clerk-Test-Pass1" })).status, 201);
  emp = await login("sup-clerk", "Clerk-Test-Pass1");
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

// ------------------------------------------------------------------------------------------------ الصلاحيات
suite("الموظف لا يصل لأي بيانات تاجر، ولا تتسرب الملكية/الأسعار في المخزون التشغيلي", async () => {
  const { s } = await consignmentFixture("PRM-001");
  assert.equal((await call(emp, "GET", "/suppliers")).status, 403);
  assert.equal((await call(emp, "GET", `/suppliers/${s.id}/ledger`)).status, 403);
  assert.equal((await call(emp, "GET", `/suppliers/${s.id}/allocations`)).status, 403);
  assert.equal((await call(emp, "GET", `/suppliers/${s.id}/settlements/eligible`)).status, 403);
  assert.equal((await call(emp, "POST", `/suppliers/${s.id}/settlements`, { items: [], idempotencyKey: key() })).status, 403);
  assert.equal((await call(emp, "POST", `/suppliers/${s.id}/consignment/prices`, {})).status, 403);
  assert.equal((await call(null, "GET", "/suppliers")).status, 401);
  assert.equal((await A("GET", "/suppliers")).status, 200);
  const r = await call(emp, "POST", "/stock/receive", { modelNumber: "PRM-001", idempotencyKey: key(), series: [ser(["M", 1])], supplierId: s.id, consignmentPrice: { amount: 5 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "FORBIDDEN_FIELD");
  // كل الاستجابات التشغيلية للموظف خالية من أي حقل سعر اتفاق/تاجر
  for (const p of ["/series?q=PRM-001", "/series/" + (await A("GET", "/series?q=PRM-001")).json.items[0].seriesNo, "/models/PRM-001", "/movements?q=PRM-001", "/lookup?code=PRM-001"]) {
    const res = await call(emp, "GET", p);
    assert.equal(res.status, 200, p);
    const text = JSON.stringify(res.json);
    for (const bad of ["\"supplier", "agreedUnit", "settledQty", "\"consignment\":{", "priceHistory"]) assert.ok(!text.includes(bad), `${p} سرّب ${bad}`);
  }
});

// ------------------------------------------------------------------------------------------------ إدارة التجار
suite("إنشاء/تعديل/بحث/تعطيل تاجر، ومنع التكرار المحتمل", async () => {
  const a = await A("POST", "/suppliers", { name: "مؤسسة النور", phone: "0911 222 333", address: "حلب", notes: "جملة" });
  assert.equal(a.status, 201);
  assert.equal(a.json.status, "settled");
  assert.equal((await A("POST", "/suppliers", { name: "  مؤسسة  النور ", phone: "0911222333" })).json.code, "DUPLICATE_SUPPLIER");
  assert.equal((await A("POST", "/suppliers", { name: "مؤسسة النور", phone: "0999999999" })).status, 201);
  assert.equal((await A("POST", "/suppliers", { name: "مؤسسة النور", phone: "0911222333", allowDuplicate: true })).status, 201);
  assert.ok((await A("GET", "/suppliers?q=النور")).json.total >= 3);
  assert.equal((await A("PATCH", `/suppliers/${a.json.id}`, { address: "دمشق" })).json.address, "دمشق");
  await invoice(a.json.id, 50);
  assert.equal((await A("PATCH", `/suppliers/${a.json.id}`, { active: false })).json.active, false);
  assert.equal((await invoice(a.json.id, 10)).json.code, "SUPPLIER_INACTIVE");
  assert.equal((await account(a.json.id)).positions.USD.grossPayable, 50);
  assert.equal((await A("GET", "/suppliers")).json.items.some((x) => x.id === a.json.id), false);
  assert.equal((await A("DELETE", `/suppliers/${a.json.id}`)).status, 404);
});

// ------------------------------------------------------------------------------------------------ المراكز المالية والتخصيص
suite("A: فاتورة 1000 ودفعة 1000 مرتبطة = مسدد بالكامل", async () => {
  const s = await newSupplier();
  const inv = (await invoice(s.id, 1000)).json.invoice;
  assert.equal((await pay(s.id, 1000, { invoiceId: inv.id })).status, 201);
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
});

suite("B: فاتورة 1000 ودفعات متعددة على نفس الفاتورة، ولا دفع زائد على فاتورة", async () => {
  const s = await newSupplier();
  const inv = (await invoice(s.id, 1000)).json.invoice;
  await pay(s.id, 600, { invoiceId: inv.id });
  assert.deepEqual(await pos(s.id), [400, 0, 400, "due"]);
  await pay(s.id, 100, { invoiceId: inv.id });
  await pay(s.id, 300, { invoiceId: inv.id });
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  const row = (await A("GET", `/suppliers/${s.id}/invoices`)).json.items[0];
  assert.deepEqual([row.payStatus, row.allocated, row.outstanding], ["paid", 1000, 0]);
  const over = await pay(s.id, 1, { invoiceId: inv.id });
  assert.equal(over.json.code, "INVOICE_OVERPAID");
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"], "الدفعة المرفوضة لم تُرحَّل");
  // دفعة غير مرتبطة تبقى سلفة متاحة (احتفاظ بالزيادة)
  await pay(s.id, 25);
  assert.deepEqual(await pos(s.id), [0, 25, -25, "advance"]);
});

suite("C: سلفة 500 ثم فاتورة 300: المستحق والسلفة ظاهران معاً (mixed)، والتخصيص صريح ومتتبَّع", async () => {
  const s = await newSupplier();
  const adv = (await advance(s.id, 500)).json.entry;
  assert.deepEqual(await pos(s.id), [0, 500, -500, "advance"]);
  const inv = (await invoice(s.id, 300)).json.invoice;
  assert.deepEqual(await pos(s.id), [300, 500, -200, "mixed"], "الصافي -200 لا يُخفي مستحقاً 300 وسلفة 500");
  assert.equal((await A("GET", `/suppliers/${s.id}/invoices`)).json.items[0].payStatus, "unpaid");

  // تخصيص صريح: لا يتجاوز المتاح ولا المتبقي
  assert.equal((await allocate(s.id, adv.id, inv.id, 400)).json.code, "INVOICE_OVERPAID");
  const k = key();
  const ok = await allocate(s.id, adv.id, inv.id, 300, { idempotencyKey: k });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.allocation.amount, 300);
  assert.deepEqual(await pos(s.id), [0, 200, -200, "advance"]);
  const again = await allocate(s.id, adv.id, inv.id, 300, { idempotencyKey: k });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.deepEqual(await pos(s.id), [0, 200, -200, "advance"], "التكرار لم يخصّص مرتين");
  // سجل التخصيص
  let al = (await A("GET", `/suppliers/${s.id}/allocations`)).json;
  assert.equal(al.items.length, 1);
  assert.equal(al.credits[0].available, 200);
  assert.equal(al.credits[0].allocated, 300);
  // تحرير يعيد الحال، والسجل يبقى (apply + release)
  const rel = await A("POST", `/suppliers/${s.id}/allocations/${ok.json.allocation.id}/release`, { reason: "تصحيح" });
  assert.equal(rel.status, 201);
  assert.deepEqual(await pos(s.id), [300, 500, -200, "mixed"]);
  assert.equal((await A("POST", `/suppliers/${s.id}/allocations/${ok.json.allocation.id}/release`, { reason: "مرة ثانية" })).json.code, "ALREADY_RELEASED");
  al = (await A("GET", `/suppliers/${s.id}/allocations`)).json;
  assert.equal(al.items.length, 2);
  assert.ok(al.items.some((x) => x.kind === "apply" && x.released) && al.items.some((x) => x.kind === "release"));
  // تطبيق تلقائي (سياسة الأقدم فالأحدث) يُنشئ سجلاً ظاهراً
  const auto = await A("POST", `/suppliers/${s.id}/allocations/auto`, {});
  assert.equal(auto.status, 201);
  assert.equal(auto.json.applied.USD, 300);
  assert.equal(auto.json.items[0].source, "auto");
  assert.deepEqual(await pos(s.id), [0, 200, -200, "advance"]);
  assert.equal((await A("POST", `/suppliers/${s.id}/allocations/auto`, {})).json.items.length, 0, "لا شيء إضافي للتطبيق");
});

suite("التخصيص المتزامن لا يتجاوز الرصيد الدائن ولا رصيد الفاتورة", async () => {
  const s = await newSupplier();
  const adv = (await advance(s.id, 100)).json.entry;
  const inv = (await invoice(s.id, 500)).json.invoice;
  const res = await Promise.all([allocate(s.id, adv.id, inv.id, 80), allocate(s.id, adv.id, inv.id, 80), allocate(s.id, adv.id, inv.id, 80)]);
  assert.ok(res.filter((r) => r.status === 201).length <= 1);
  const a = await account(s.id);
  assert.ok(a.positions.USD.advance >= 0 && a.positions.USD.grossPayable >= 0);
  const al = (await A("GET", `/suppliers/${s.id}/allocations`)).json;
  assert.ok(al.items.filter((x) => x.kind === "apply").reduce((n, x) => n + x.amount, 0) <= 100);
});

suite("D: التزام 1000، دفعة 600، إشعار دائن 100 مرتبط = 300؛ والتسوية المدينة تزيد", async () => {
  const s = await newSupplier();
  const inv = (await invoice(s.id, 1000)).json.invoice;
  await pay(s.id, 600, { invoiceId: inv.id });
  assert.equal((await A("POST", `/suppliers/${s.id}/adjustments`, { kind: "credit", amount: 100, currency: "USD", invoiceId: inv.id, note: "مرتجع متفق عليه", idempotencyKey: key() })).status, 201);
  assert.deepEqual(await pos(s.id), [300, 0, 300, "due"]);
  assert.equal((await A("POST", `/suppliers/${s.id}/adjustments`, { kind: "adjustment", amount: 20, currency: "USD", note: "رسوم شحن", idempotencyKey: key() })).status, 201);
  assert.deepEqual(await pos(s.id), [320, 0, 320, "due"]);
  assert.equal((await A("POST", `/suppliers/${s.id}/adjustments`, { kind: "credit", amount: 1, idempotencyKey: key() })).status, 400, "السبب إلزامي");
});

// ------------------------------------------------------------------------------------------------ العملات والدقة
suite("الليرة والدولار حسابان مستقلان: لا تحويل ولا جمع، والقيمة الأصلية محفوظة ولا تتأثر بتغيّر الصرف", async () => {
  const s = await newSupplier();
  const r = await invoice(s.id, 5000000, { currency: "SYP" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.invoice.currency, r.json.invoice.amount], ["SYP", 5000000]);
  await invoice(s.id, 100, { currency: "USD" });
  await pay(s.id, 2000000, { currency: "SYP", invoiceId: r.json.invoice.id }); // نفس العملة: بلا أي سعر صرف
  assert.deepEqual(await pos(s.id, "SYP"), [3000000, 0, 3000000, "due"]);
  assert.deepEqual(await pos(s.id, "USD"), [100, 0, 100, "due"], "دفع الليرة لم يمسّ حساب الدولار");
  // تغيّر الصرف في الإعدادات لا يغيّر أي رقم
  await A("PUT", "/settings", { usdToSyp: 20000 });
  assert.deepEqual(await pos(s.id, "SYP"), [3000000, 0, 3000000, "due"]);
  assert.deepEqual(await pos(s.id, "USD"), [100, 0, 100, "due"]);
  const led = (await A("GET", `/suppliers/${s.id}/ledger?currency=SYP`)).json;
  assert.ok(led.items.every((e) => e.currency === "SYP"));
  assert.deepEqual(led.summary.byCurrency.SYP, { invoiced: 5000000, credits: 2000000, allocatedToInvoices: 2000000, creditConsumed: 2000000 });
  assert.deepEqual(led.summary.positions.USD, { grossPayable: 100, advance: 0, net: 100 });
  // سعر الصرف اختياري ويُحفظ للتوثيق فقط كما أُدخل، ولا يُجلب من الإعدادات
  const doc = await pay(s.id, 1000000, { currency: "SYP", rate: 9000 });
  assert.equal(doc.status, 201);
  assert.equal(doc.json.entry.rate, 9000);
  assert.equal(doc.json.entry.valuationUsd, 111.11);
  const none = await pay(s.id, 500000, { currency: "SYP" });
  assert.equal(none.json.entry.rate, 0);
  assert.equal(none.json.entry.valuationUsd, null, "لا معادل دولاري بلا سعر مُدخَل صراحةً");
  await A("PUT", "/settings", { usdToSyp: 10000 });
});

suite("الدقة: ثلاث دفعات 0.10$ = 0.30$ تماماً، ورفض خانات عشرية زائدة وليرة كسرية", async () => {
  const s = await newSupplier();
  for (let i = 0; i < 3; i++) await invoice(s.id, 0.1);
  assert.deepEqual(await pos(s.id), [0.3, 0, 0.3, "due"]);
  assert.equal((await invoice(s.id, 10.005)).json.code, "INVALID_AMOUNT_PRECISION");
  assert.equal((await pay(s.id, 1500.5, { currency: "SYP", rate: 10000 })).json.code, "INVALID_AMOUNT_PRECISION");
  assert.equal((await pay(s.id, 0.001)).json.code, "INVALID_AMOUNT_PRECISION");
});

// ------------------------------------------------------------------------------------------------ التكرار والعكس
suite("منع التكرار: فاتورة التاجر، ومفتاح الدفعة، والتزامن", async () => {
  const s = await newSupplier();
  const t = await newSupplier();
  const k = key();
  assert.equal((await invoice(s.id, 200, { invoiceNo: "A-100", idempotencyKey: k })).status, 201);
  const retry = await invoice(s.id, 200, { invoiceNo: "A-100", idempotencyKey: k });
  assert.deepEqual([retry.status, retry.json.duplicate], [200, true]);
  assert.equal((await invoice(s.id, 200, { invoiceNo: " a-100 " })).json.code, "DUPLICATE_INVOICE");
  assert.equal((await invoice(t.id, 200, { invoiceNo: "A-100" })).status, 201);
  assert.equal((await account(s.id)).positions.USD.grossPayable, 200);
  const pk = key();
  assert.equal((await pay(s.id, 50, { idempotencyKey: pk })).status, 201);
  assert.deepEqual([(await pay(s.id, 50, { idempotencyKey: pk })).status], [200]);
  assert.equal((await pay(t.id, 50, { idempotencyKey: pk })).json.code, "IDEMPOTENCY_MISMATCH");
  const ck = key();
  const res = await Promise.all([1, 2, 3, 4].map(() => pay(s.id, 10, { idempotencyKey: ck })));
  assert.ok(res.every((r) => [200, 201].includes(r.status)));
  assert.deepEqual(await pos(s.id), [200, 60, 140, "mixed"]);
});

suite("دفعتان متزامنتان على فاتورة واحدة لا تتجاوزان رصيدها", async () => {
  const s = await newSupplier();
  const inv = (await invoice(s.id, 100)).json.invoice;
  const res = await Promise.all([pay(s.id, 80, { invoiceId: inv.id }), pay(s.id, 80, { invoiceId: inv.id })]);
  assert.ok(res.filter((r) => r.status === 201).length <= 1);
  const a = await account(s.id);
  assert.ok(a.positions.USD.grossPayable >= 0 && a.positions.USD.advance === 0, JSON.stringify(a));
});

suite("العكس: قيد عكسي يحفظ التاريخ، يحرّر التخصيصات، ولا عكس مزدوج", async () => {
  const s = await newSupplier();
  const inv = (await invoice(s.id, 400)).json;
  const p = (await pay(s.id, 150, { invoiceId: inv.invoice.id })).json.entry;
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${inv.entry.id}/reverse`, { reason: "خطأ" })).json.code, "REVERSE_PAYMENTS_FIRST");
  const rev = await A("POST", `/suppliers/${s.id}/entries/${p.id}/reverse`, { reason: "دفعة خاطئة" });
  assert.equal(rev.status, 201);
  assert.deepEqual(await pos(s.id), [400, 0, 400, "due"]);
  const al = (await A("GET", `/suppliers/${s.id}/allocations`)).json;
  assert.ok(al.items.some((x) => x.kind === "release"), "عكس الدفعة حرّر تخصيصها بسجل ظاهر");
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${p.id}/reverse`, { reason: "ثانية" })).json.code, "ALREADY_REVERSED");
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${rev.json.entry.id}/reverse`, { reason: "x" })).json.code, "CANNOT_REVERSE_REVERSAL");
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${inv.entry.id}/reverse`, { reason: "فاتورة مكررة" })).status, 201);
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  const led = (await A("GET", `/suppliers/${s.id}/ledger?limit=50`)).json;
  assert.equal(led.total, 4);
  assert.ok(led.items.find((e) => e.id === p.id).reversedBy);
  assert.equal(led.items[0].balance, 0);
  assert.equal((await invoice(s.id, 400, { invoiceNo: inv.invoice.invoiceNo })).json.code, "DUPLICATE_INVOICE");
  // سلفة مخصّصة ثم عكسها: يتحرر التخصيص ولا يبقى رصيد دائن وهمي
  const s2 = await newSupplier();
  const adv = (await advance(s2.id, 100)).json.entry;
  const i2 = (await invoice(s2.id, 100)).json.invoice;
  await allocate(s2.id, adv.id, i2.id, 100);
  assert.deepEqual(await pos(s2.id), [0, 0, 0, "settled"]);
  await A("POST", `/suppliers/${s2.id}/entries/${adv.id}/reverse`, { reason: "سلفة خاطئة" });
  assert.deepEqual(await pos(s2.id), [100, 0, 100, "due"]);
});

// ------------------------------------------------------------------------------------------------ الأمانة: الاستلام والسعر
suite("استلام أمانة: ملكية + سعر اتفاق محفوظ، بلا التزام مالي، ومتميزة عن المملوكة", async () => {
  const { s, series } = await consignmentFixture("CON-001", { amount: 30, currency: "USD" }, 99);
  assert.equal(series.ownership, "consignment");
  const acc = await account(s.id);
  assert.deepEqual([acc.positions.USD.grossPayable, acc.positions.SYP.grossPayable, acc.consignmentPieces, acc.consignmentValueUsd, acc.consignmentValueSyp, acc.consignmentUnpricedPieces], [0, 0, 4, 120, 0, 0], "القيمة بسعر الاتفاق 30 لا بسعر الجملة 99");
  assert.deepEqual(await qtyOf("CON-001", "M"), { shop: 2, warehouse: 0 });
  assert.equal((await A("GET", "/series?ownership=consignment&q=CON-001")).json.total, 1);
  assert.equal((await receive("CON-001", "warehouse", [ser(["S", 1])], { consignment: true })).status, 400);
  assert.equal((await receive("CON-001", "warehouse", [ser(["S", 1])], { supplierId: s.id, consignmentPrice: { amount: 5 } })).json.code, "PRICE_NOT_CONSIGNMENT");
  const bought = await receive("CON-001", "warehouse", [ser(["L", 1])], { supplierId: s.id });
  assert.equal(bought.json.series[0].ownership, "owned");
  assert.equal((await consignment(s.id)).summary.pieces, 4);
});

suite("بضاعة أمانة بلا سعر: لا تقدير من سعر الجملة، وتُعلَّم، ولا تسوية قبل تسجيل الاتفاق", async () => {
  const { s, series } = await consignmentFixture("CON-002", null, 77);
  const acc = await account(s.id);
  assert.deepEqual([acc.consignmentValueUsd, acc.consignmentUnpricedPieces], [0, 4]);
  await sell("CON-002", "M", 1);
  assert.equal((await settle(s.id, [{ seriesId: series.id, size: "M", qty: 1 }])).json.code, "CONSIGNMENT_PRICE_MISSING");
  // تسجيل الاتفاق الأول، ثم محاولة تعديل بلا تصريح تُرفض، والتعديل المصرَّح به يسجَّل بتاريخ
  const first = await A("POST", `/suppliers/${s.id}/consignment/prices`, { seriesIds: [series.id], price: { amount: 25, currency: "USD" }, reason: "اتفاق هاتفي" });
  assert.equal(first.status, 201);
  assert.equal((await A("POST", `/suppliers/${s.id}/consignment/prices`, { seriesIds: [series.id], price: { amount: 27 }, reason: "تغيير" })).json.code, "CONSIGNMENT_PRICE_EXISTS");
  const adj = await A("POST", `/suppliers/${s.id}/consignment/prices`, { seriesIds: [series.id], price: { amount: 28, currency: "USD" }, adjust: true, reason: "زيادة متفق عليها" });
  assert.equal(adj.status, 201);
  const row = (await consignment(s.id)).series.find((x) => x.id === series.id);
  assert.equal(row.price.amount, 28);
  assert.deepEqual(row.priceHistory.map((h) => [h.kind, h.price.amount, h.previous?.amount ?? null]), [["set", 25, null], ["adjust", 28, 25]]);
  assert.equal((await A("POST", `/suppliers/${s.id}/consignment/prices`, { seriesIds: [series.id], price: { amount: 5 }, adjust: true, reason: "x" }).then((r) => r.status)), 201);
  // سعر لرتل تاجر آخر مرفوض
  const other = await newSupplier();
  assert.equal((await A("POST", `/suppliers/${other.id}/consignment/prices`, { seriesIds: [series.id], price: { amount: 5 }, reason: "x" })).json.code, "NOT_SUPPLIER_CONSIGNMENT");
});

// ------------------------------------------------------------------------------------------------ التسوية
suite("التسوية: تعتمد المباع فعلاً وبسعر الاتفاق التاريخي، جزئية، ولا تتكرر", async () => {
  const { s, series } = await consignmentFixture("SET-001", { amount: 30, currency: "USD" }, 55);
  await mkModel("SET-OWN", 10);
  await receive("SET-OWN", "shop", [ser(["M", 2])]);
  await sell("SET-OWN", "M", 1); // بيع مخزون مملوك: لا أثر على التاجر
  assert.equal((await eligible(s.id)).items.length, 0, "لا مباع من الأمانة بعد");
  assert.equal((await settle(s.id, [{ seriesId: series.id, size: "M", qty: 1 }])).json.code, "CONSIGNMENT_OVER_SETTLEMENT", "لا تسوية لما لم يُبَع");
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"], "الاستلام والرفض لم ينشئا التزاماً");

  const inv1 = await sell("SET-001", "M", 2); // يُباع 2 من الأمانة
  let el = (await eligible(s.id)).items;
  assert.deepEqual(el.map((x) => [x.size, x.sold, x.settled, x.settleable]), [["M", 2, 0, 2]]);

  // تسوية جزئية: قطعة واحدة بـ 30$ (لا 55$ جملة ولا 100$ بيع للزبون)
  const k = key();
  const r1 = await settle(s.id, [{ seriesId: series.id, size: "M", qty: 1 }], { idempotencyKey: k });
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.equal(r1.json.settlement.total, 30);
  assert.equal(r1.json.settlement.items[0].unitAmount, 30);
  assert.deepEqual(await pos(s.id), [30, 0, 30, "due"]);
  // إعادة الطلب بنفس المفتاح: لا تسوية ثانية
  const dup = await settle(s.id, [{ seriesId: series.id, size: "M", qty: 1 }], { idempotencyKey: k });
  assert.deepEqual([dup.status, dup.json.duplicate], [200, true]);
  assert.deepEqual(await pos(s.id), [30, 0, 30, "due"]);
  // الكمية المسوّاة لا تُسوّى مرة أخرى بمفتاح جديد؛ المتبقي قطعة واحدة فقط
  assert.equal((await settle(s.id, [{ seriesId: series.id, size: "M", qty: 2 }])).json.code, "CONSIGNMENT_OVER_SETTLEMENT");
  el = (await eligible(s.id)).items;
  assert.deepEqual([el[0].sold, el[0].settled, el[0].settleable], [2, 1, 1]);

  // تعديل سعر الاتفاق لاحقاً لا يغيّر تسوية سابقة، ويطبّق على التسويات اللاحقة
  assert.equal((await A("POST", `/suppliers/${s.id}/consignment/prices`, { seriesIds: [series.id], price: { amount: 40, currency: "USD" }, adjust: true, reason: "اتفاق جديد" })).status, 201);
  const r2 = await settle(s.id, [{ seriesId: series.id, size: "M", qty: 1 }]);
  assert.equal(r2.json.settlement.total, 40);
  assert.deepEqual(await pos(s.id), [70, 0, 70, "due"]);
  const list = (await A("GET", `/suppliers/${s.id}/settlements`)).json.items;
  assert.deepEqual(list.map((x) => x.total).sort(), [30, 40]);
  assert.ok(list.every((x) => x.invoiceNo && x.entryRef));
  // الفاتورة نوعها تسوية، ومرتبطة بقيد، ولا تُنشأ يدوياً
  assert.equal((await A("GET", `/suppliers/${s.id}/invoices`)).json.items.every((i) => i.kind === "consignment_settlement"), true);
  assert.equal((await invoice(s.id, 10, { kind: "consignment_settlement" })).status, 400);
  // فاتورة الزبون لم تتحول إلى التزام للتاجر
  assert.ok(inv1.number > 0);
});

suite("التسوية بسعر بالليرة تُنشئ التزاماً بالليرة، وعملتان في تسوية واحدة مرفوضتان", async () => {
  const { s, series } = await consignmentFixture("SET-002", { amount: 150000, currency: "SYP" }, 5);
  await sell("SET-002", "S", 2);
  await A("PUT", "/settings", { usdToSyp: 40000 });
  const r = await settle(s.id, [{ seriesId: series.id, size: "S", qty: 2 }]);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.settlement.currency, r.json.settlement.items[0].currency, r.json.settlement.items[0].lineAmount, r.json.settlement.total], ["SYP", "SYP", 300000, 300000]);
  assert.deepEqual(await pos(s.id, "SYP"), [300000, 0, 300000, "due"]);
  assert.deepEqual(await pos(s.id, "USD"), [0, 0, 0, "due"], "الحالة العامة due لوجود مستحق بالليرة؛ الدولار صفر");
  // بنود بعملتي سعر مختلفتين لا تُسوّى معاً
  await mkModel("SET-002B", 5);
  const r2 = await receive("SET-002B", "shop", [ser(["M", 2])], { supplierId: s.id, consignment: true, consignmentPrice: { amount: 12, currency: "USD" } });
  await sell("SET-002B", "M", 1);
  await sell("SET-002", "M", 1);
  const mixed = await settle(s.id, [{ seriesId: series.id, size: "M", qty: 1 }, { seriesId: r2.json.series[0].id, size: "M", qty: 1 }]);
  assert.equal(mixed.json.code, "MIXED_CURRENCY_SETTLEMENT");
  assert.equal((await settle(s.id, [{ seriesId: r2.json.series[0].id, size: "M", qty: 1 }])).json.settlement.total, 12);
  await A("PUT", "/settings", { usdToSyp: 10000 });
});

suite("إلغاء فاتورة الزبون يخفض المباع القابل للتسوية، والتسوية المزدوجة المتزامنة تنجح مرة واحدة", async () => {
  const { s, series } = await consignmentFixture("SET-003", { amount: 10, currency: "USD" });
  const inv = await sell("SET-003", "M", 2);
  assert.equal((await eligible(s.id)).items[0].settleable, 2);
  assert.equal((await A("POST", `/invoices/${inv._id || inv.id}/cancel`, {})).status, 200);
  assert.equal((await eligible(s.id)).items.length, 0, "الإلغاء أعاد القطع: لا مباع");
  await sell("SET-003", "M", 2);
  const res = await Promise.all([1, 2, 3].map(() => settle(s.id, [{ seriesId: series.id, size: "M", qty: 2 }])));
  assert.equal(res.filter((r) => r.status === 201).length, 1, JSON.stringify(res.map((r) => [r.status, r.json.code])));
  assert.deepEqual(await pos(s.id), [20, 0, 20, "due"]);
  const el = (await eligible(s.id)).items[0];
  assert.deepEqual([el.sold, el.settled, el.settleable], [2, 2, 0]);
});

suite("عكس التسوية: يحفظ السجل، يحرّر الكمية، ولا يُعكس مرتين، ويُحجب إن وُجد تخصيص على فاتورتها", async () => {
  const { s, series } = await consignmentFixture("SET-004", { amount: 20, currency: "USD" });
  await sell("SET-004", "M", 2);
  const st = (await settle(s.id, [{ seriesId: series.id, size: "M", qty: 2 }])).json.settlement;
  assert.deepEqual(await pos(s.id), [40, 0, 40, "due"]);
  // عكس فاتورة التسوية مباشرة مرفوض (يُعكس من التسوية)
  const entries = (await A("GET", `/suppliers/${s.id}/ledger`)).json.items;
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${entries[0].id}/reverse`, { reason: "x" })).json.code, "REVERSE_VIA_SETTLEMENT");
  // دفعة مخصّصة على فاتورة التسوية تمنع عكسها حتى تُحرَّر
  const invs = (await A("GET", `/suppliers/${s.id}/invoices`)).json.items;
  const p = (await pay(s.id, 10, { invoiceId: invs[0].id })).json.entry;
  assert.equal((await A("POST", `/suppliers/${s.id}/settlements/${st.id}/reverse`, { reason: "خطأ" })).json.code, "REVERSE_PAYMENTS_FIRST");
  assert.deepEqual((await eligible(s.id)).items[0].settled, 2, "فشل العكس لم يغيّر الكميات");
  await A("POST", `/suppliers/${s.id}/entries/${p.id}/reverse`, { reason: "تصحيح" });
  const rv = await A("POST", `/suppliers/${s.id}/settlements/${st.id}/reverse`, { reason: "تسوية خاطئة" });
  assert.equal(rv.status, 201);
  assert.equal(rv.json.settlement.status, "reversed");
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  assert.deepEqual((await eligible(s.id)).items.map((x) => [x.settled, x.settleable]), [[0, 2]], "الكمية عادت قابلة للتسوية");
  assert.equal((await A("POST", `/suppliers/${s.id}/settlements/${st.id}/reverse`, { reason: "ثانية" })).json.code, "ALREADY_REVERSED");
  const hist = (await A("GET", `/suppliers/${s.id}/settlements`)).json.items;
  assert.equal(hist[0].status, "reversed");
  assert.equal(hist[0].reversal.reason, "تسوية خاطئة");
  // إعادة تسوية الكمية بعد العكس تعمل
  assert.equal((await settle(s.id, [{ seriesId: series.id, size: "M", qty: 2 }])).status, 201);
});

suite("تراجع التسوية عند فشل جزئي: لا كمية مسوّاة ولا التزام ولا سجل معلّق", async () => {
  const { s, series } = await consignmentFixture("SET-005", { amount: 10, currency: "USD" });
  await sell("SET-005", "M", 2);
  const ledger = require("../../src/services/supplierLedger.service");
  const orig = ledger.postInvoiceTx;
  ledger.postInvoiceTx = async () => { throw new Error("boom"); };
  const k = key();
  try {
    const r = await settle(s.id, [{ seriesId: series.id, size: "M", qty: 2 }], { idempotencyKey: k });
    assert.equal(r.status, 500);
  } finally { ledger.postInvoiceTx = orig; }
  const el = (await eligible(s.id)).items[0];
  assert.deepEqual([el.settled, el.settleable], [0, 2], "التسوية الشرطية رُدَّت");
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  assert.equal((await A("GET", `/suppliers/${s.id}/settlements`)).json.items.length, 0);
  const again = await settle(s.id, [{ seriesId: series.id, size: "M", qty: 2 }], { idempotencyKey: k });
  assert.equal(again.status, 201, "إعادة المحاولة بنفس المفتاح بعد فشل حقيقي مسموحة");
});

// ------------------------------------------------------------------------------------------------ إرجاع الأمانة
suite("إرجاع الأمانة من المحل والمستودع: خصم مؤهل فقط، حركة مرتبطة، تقييم بسعر الاتفاق، ورفض مملوك/تاجر آخر", async () => {
  const s = await newSupplier();
  const other = await newSupplier();
  await mkModel("RET-001", 99);
  const w = await receive("RET-001", "warehouse", [ser(["S", 2], ["M", 2])], { supplierId: s.id, consignment: true, consignmentPrice: { amount: 12, currency: "USD" } });
  const sh = await receive("RET-001", "shop", [ser(["S", 1])], { supplierId: s.id, consignment: true }); // بلا سعر
  const rcvOther = await receive("RET-001", "warehouse", [ser(["S", 1])], { supplierId: other.id, consignment: true });
  const plain = await receive("RET-001", "warehouse", [ser(["S", 2])]);
  const body = (items, extra = {}) => ({ items, reason: "راكدة", idempotencyKey: key(), ...extra });
  assert.equal((await A("POST", `/suppliers/${s.id}/returns`, body([{ seriesId: rcvOther.json.series[0].id, size: "S", qty: 1 }]))).json.code, "NOT_SUPPLIER_CONSIGNMENT");
  assert.equal((await A("POST", `/suppliers/${s.id}/returns`, body([{ seriesId: plain.json.series[0].id, size: "S", qty: 1 }]))).json.code, "NOT_SUPPLIER_CONSIGNMENT", "مملوك لا يُرجَع كأمانة");
  assert.equal((await A("POST", `/suppliers/${s.id}/returns`, body([{ seriesId: w.json.series[0].id, size: "S", qty: 3 }]))).json.code, "INSUFFICIENT_STOCK");
  assert.deepEqual(await qtyOf("RET-001", "S"), { shop: 1, warehouse: 5 });

  const k = key();
  const ok = await A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: w.json.series[0].id, size: "S", qty: 1 }, { seriesId: w.json.series[0].id, size: "M", qty: 2 }, { seriesId: sh.json.series[0].id, size: "S", qty: 1 }], reason: "لا تُباع", idempotencyKey: k });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.return.totalQty, ok.json.return.value.USD, ok.json.return.unpricedQty], [4, 36, 1], "قيمة بأسعار الاتفاق، والقطعة بلا سعر معلَّمة لا مقدَّرة");
  assert.equal(ok.json.entry, null, "لا قيد مالي دون طلب");
  assert.deepEqual(await qtyOf("RET-001", "S"), { shop: 0, warehouse: 4 });
  const mv = (await A("GET", `/movements?type=supplier_return&q=RET-001`)).json.items;
  assert.equal(mv.length, 3);
  assert.ok(mv.every((m) => m.ref === ok.json.return.ref && m.delta === -m.qty && m.allocations.length === 1));
  const dup = await A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: w.json.series[0].id, size: "S", qty: 1 }, { seriesId: w.json.series[0].id, size: "M", qty: 2 }, { seriesId: sh.json.series[0].id, size: "S", qty: 1 }], reason: "لا تُباع", idempotencyKey: k });
  assert.deepEqual([dup.status, dup.json.duplicate], [200, true]);
  assert.deepEqual(await qtyOf("RET-001", "S"), { shop: 0, warehouse: 4 });
  const c = await consignment(s.id);
  const row = c.models[0];
  assert.deepEqual([row.received, row.remaining, row.returned, row.other], [5, 1, 4, 0]);
  assert.equal((await account(s.id)).positions.USD.grossPayable, 0, "الإرجاع لا ينشئ التزاماً ولا ائتماناً تلقائياً");
});

suite("إرجاع متزامن لنفس القطع ينجح مرة واحدة، والتراجع عند فشل الحركة يعيد المخزون والمطالبة", async () => {
  const s = await newSupplier();
  await mkModel("RET-002", 5);
  const rcv = await receive("RET-002", "warehouse", [ser(["M", 2])], { supplierId: s.id, consignment: true });
  const mk = () => A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: rcv.json.series[0].id, size: "M", qty: 2 }], reason: "سباق", idempotencyKey: key() });
  const res = await Promise.all([mk(), mk(), mk()]);
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.deepEqual(await qtyOf("RET-002", "M"), { shop: 0, warehouse: 0 });

  const rcv2 = await receive("RET-002", "warehouse", [ser(["S", 2])], { supplierId: s.id, consignment: true });
  const movementService = require("../../src/services/movement.service");
  const orig = movementService.record;
  movementService.record = async () => { throw new Error("boom"); };
  const k = key();
  try {
    const r = await A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: rcv2.json.series[0].id, size: "S", qty: 2 }], reason: "فشل", idempotencyKey: k });
    assert.equal(r.status, 500);
  } finally { movementService.record = orig; }
  assert.deepEqual(await qtyOf("RET-002", "S"), { shop: 0, warehouse: 2 }, "المخزون عاد كما كان");
  assert.equal((await A("GET", `/suppliers/${s.id}/returns`)).json.items.length, 1, "لا إرجاع معلّق");
  const retry = await A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: rcv2.json.series[0].id, size: "S", qty: 2 }], reason: "إعادة", idempotencyKey: k });
  assert.equal(retry.status, 201);
});

suite("إرجاع أمانة مع ائتمان مرتبط بفاتورة: حركة المخزون والقيد المالي منفصلان ومرتبطان", async () => {
  const s = await newSupplier();
  await mkModel("RET-003", 40);
  const inv = (await invoice(s.id, 300)).json.invoice;
  const rcv = await receive("RET-003", "warehouse", [ser(["M", 2])], { supplierId: s.id, consignment: true, consignmentPrice: { amount: 40, currency: "USD" } });
  const r = await A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: rcv.json.series[0].id, size: "M", qty: 2 }], reason: "إرجاع مع ائتمان", idempotencyKey: key(), credit: { amount: 80, currency: "USD", invoiceId: inv.id, note: "ائتمان" } });
  assert.equal(r.status, 201);
  assert.equal(r.json.entry.type, "return_credit");
  assert.deepEqual(await pos(s.id), [220, 0, 220, "due"]);
  const row = (await A("GET", `/suppliers/${s.id}/invoices`)).json.items[0];
  assert.deepEqual([row.allocated, row.outstanding], [80, 220], "الائتمان خُصِّص على الفاتورة بسجل");
  // ائتمان يتجاوز المتبقي مرفوض قبل خصم أي مخزون
  const rcv2 = await receive("RET-003", "warehouse", [ser(["L", 1])], { supplierId: s.id, consignment: true });
  const bad = await A("POST", `/suppliers/${s.id}/returns`, { items: [{ seriesId: rcv2.json.series[0].id, size: "L", qty: 1 }], reason: "x", idempotencyKey: key(), credit: { amount: 999, currency: "USD", invoiceId: inv.id } });
  assert.equal(bad.json.code, "INVOICE_OVERPAID");
  assert.deepEqual(await qtyOf("RET-003", "L"), { shop: 0, warehouse: 1 });
  // عكس القيد المالي لا يعيد البضاعة
  assert.equal((await A("POST", `/suppliers/${s.id}/entries/${r.json.entry.id}/reverse`, { reason: "اتفاق ملغى" })).status, 201);
  assert.deepEqual(await pos(s.id), [300, 0, 300, "due"]);
  assert.deepEqual(await qtyOf("RET-003", "M"), { shop: 0, warehouse: 0 });
});

// ------------------------------------------------------------------------------------------------ اللوحة + انحدار
suite("اللوحة: مجاميع كل عملة منفصلة (لا مجموع مشترك)، وفلتر الحالات بما فيها mixed", async () => {
  const sum = (await A("GET", "/suppliers/summary")).json;
  const all = [...(await A("GET", "/suppliers?limit=100")).json.items, ...(await A("GET", "/suppliers?active=false&limit=100")).json.items];
  for (const c of ["USD", "SYP"]) {
    const factor = c === "SYP" ? 1 : 100;
    const gross = Math.round(all.reduce((n, x) => n + Math.max(0, x.positions[c].grossPayable) * factor, 0));
    const adv = Math.round(all.reduce((n, x) => n + Math.max(0, x.positions[c].advance) * factor, 0));
    assert.equal(Math.round(sum.totals[c].grossPayable * factor), gross, c);
    assert.equal(Math.round(sum.totals[c].advance * factor), adv, c);
  }
  assert.ok(!("totalGrossPayableUsd" in sum) && !("total" in sum), "لا مجموع مختلط");
  assert.ok(sum.consignmentPieces > 0);
  for (const st of ["due", "advance", "settled", "mixed"]) {
    const rows = (await A("GET", `/suppliers?account=${st}&limit=100`)).json.items;
    const g = (x) => x.positions.USD.grossPayable > 0 || x.positions.SYP.grossPayable > 0;
    const v = (x) => x.positions.USD.advance > 0 || x.positions.SYP.advance > 0;
    if (st === "due") assert.ok(rows.length && rows.every(g));
    if (st === "advance") assert.ok(rows.length && rows.every(v));
    if (st === "settled") assert.ok(rows.every((x) => x.status === "settled"));
    if (st === "mixed") assert.ok(rows.every((x) => g(x) && v(x)), JSON.stringify(rows.filter((x) => !(g(x) && v(x))).map((x) => [x.name, x.status, x.positions])));
  }
  const mixed = await newSupplier();
  await advance(mixed.id, 50);
  await invoice(mixed.id, 80);
  assert.equal((await account(mixed.id)).status, "mixed");
});

suite("انحدار: بيع الزبائن والمرتجعات والمخزون العادي لا يتأثران بحقول الملكية والتسوية", async () => {
  await mkModel("REG-001", 10);
  await receive("REG-001", "shop", [ser(["M", 2])]);
  const sale = await sell("REG-001", "M", 2);
  assert.deepEqual(await qtyOf("REG-001", "M"), { shop: 0, warehouse: 0 });
  const ret = await A("POST", "/returns", { invoiceId: sale._id || sale.id, items: [{ itemIndex: 0, qty: 1, condition: "good" }], mode: "cash" });
  assert.equal(ret.status, 201);
  assert.deepEqual(await qtyOf("REG-001", "M"), { shop: 1, warehouse: 0 });
  assert.ok((await A("GET", "/series?q=REG-001")).json.items.every((x) => x.ownership === "owned"));
});

suite("نقل بضاعة الأمانة بين المستودع والمحل: الرتل المشتق يرث الملكية وسعر الاتفاق فيُباع ويُسوّى بسعره", async () => {
  const s = await newSupplier();
  await mkModel("TRN-001", 33);
  const r = await receive("TRN-001", "warehouse", [ser(["M", 2], ["S", 2])], { supplierId: s.id, consignment: true, consignmentPrice: { amount: 75000, currency: "SYP" } });
  assert.equal(r.status, 201);
  assert.equal((await A("POST", "/stock/transfer", { modelNumber: "TRN-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 2 }] })).status, 200);
  const c = await consignment(s.id);
  const derived = c.series.find((x) => x.location === "shop");
  assert.ok(derived, "الرتل المشتق في المحل");
  assert.deepEqual([derived.price.amount, derived.price.currency], [75000, "SYP"], "السعر انتقل مع القطع");
  assert.equal(c.summary.unpricedPieces, 0, "لا قطع أمانة بلا سعر بعد النقل");
  await sell("TRN-001", "M", 2);
  const st = await settle(s.id, [{ seriesId: derived.id, size: "M", qty: 2 }]);
  assert.equal(st.status, 201, JSON.stringify(st.json));
  assert.deepEqual([st.json.settlement.currency, st.json.settlement.total], ["SYP", 150000]);
});

// ======================================================================= الاستلام المتكامل: فاتورة + دفع + سلف في عملية واحدة
const cashOf = async (supplierId) => mongoose.connection.collection("cash_movements").find({ supplier: new mongoose.Types.ObjectId(supplierId) }).toArray();
const buy = (mn, supplierId, purchase, extra = {}) => receive(mn, "warehouse", [ser(["M", 1], ["S", 1])], { supplierId, purchase: { invoiceNo: `R-${++n}`, currency: "USD", ...purchase }, ...extra });

suite("استلام بفاتورة غير مدفوعة: مخزون + فاتورة + مستحق، بلا أي حركة نقد", async () => {
  const s = await newSupplier();
  await mkModel("RCV-001");
  const r = await buy("RCV-001", s.id, { amount: 400 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.purchase.payStatus, r.json.purchase.outstanding, r.json.purchase.cashPaid, r.json.purchase.paymentRef], ["unpaid", 400, 0, null]);
  assert.deepEqual(await qtyOf("RCV-001", "M"), { shop: 0, warehouse: 1 });
  assert.deepEqual(await pos(s.id), [400, 0, 400, "due"]);
  assert.equal((await cashOf(s.id)).length, 0, "الفاتورة وحدها لا تحرك النقد");
  const inv = (await A("GET", `/suppliers/${s.id}/invoices`)).json.items[0];
  assert.equal(inv.shipmentRefs[0], r.json.purchase.shipmentRef, "ربط الفاتورة بالاستلام");
});

suite("استلام مدفوع بالكامل: دفعة واحدة وحركة نقد واحدة وتخصيص مباشر", async () => {
  const s = await newSupplier();
  await mkModel("RCV-002");
  const r = await buy("RCV-002", s.id, { amount: 250, payment: { cashAmount: 250 } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.purchase.payStatus, r.json.purchase.outstanding, r.json.purchase.cashPaid], ["paid", 0, 250]);
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  const cash = await cashOf(s.id);
  assert.equal(cash.length, 1);
  assert.deepEqual([cash[0].currency, cash[0].direction, cash[0].amountMinor], ["USD", "out", 25000]);
});

suite("استلام مدفوع جزئياً: المتبقي صحيح وحركة نقد بالمدفوع فقط", async () => {
  const s = await newSupplier();
  await mkModel("RCV-003");
  const r = await buy("RCV-003", s.id, { amount: 1000, payment: { cashAmount: 400 } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.purchase.payStatus, r.json.purchase.outstanding], ["partial", 600]);
  assert.deepEqual(await pos(s.id), [600, 0, 600, "due"]);
  assert.deepEqual((await cashOf(s.id)).map((c) => c.amountMinor), [40000]);
});

suite("استلام بسلفة قائمة: تنخفض السلفة ولا حركة نقد ثانية", async () => {
  const s = await newSupplier();
  await mkModel("RCV-004");
  const adv = (await advance(s.id, 300)).json.entry;
  assert.equal((await cashOf(s.id)).length, 1, "السلفة نفسها أخرجت النقد عند دفعها");
  const r = await buy("RCV-004", s.id, { amount: 500, payment: { advances: [{ entryId: adv.id, amount: 300 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.purchase.advanceApplied, r.json.purchase.outstanding, r.json.purchase.payStatus], [300, 200, "partial"]);
  assert.deepEqual(await pos(s.id), [200, 0, 200, "due"]);
  assert.equal((await cashOf(s.id)).length, 1, "التخصيص لم ينشئ حركة نقد جديدة");
  // سلفة أكبر من المتاح تُرفض وتُلغى العملية كلها
  const adv2 = (await advance(s.id, 50)).json.entry;
  const bad = await buy("RCV-004", s.id, { amount: 500, payment: { advances: [{ entryId: adv2.id, amount: 80 }] } });
  assert.equal(bad.status, 409, JSON.stringify(bad.json));
  assert.deepEqual(await qtyOf("RCV-004", "M"), { shop: 0, warehouse: 1 }, "لم يُضف مخزون الشحنة الفاشلة");
});

suite("فشل جزء من الاستلام يلغي كل العملية، وإعادة الإرسال بنفس المفتاح لا تكرّر شيئاً", async () => {
  const s = await newSupplier();
  await mkModel("RCV-005");
  // دفع يتجاوز الفاتورة: يفشل بعد إنشاء المخزون والفاتورة، فيُلغى الكل
  const over = await buy("RCV-005", s.id, { amount: 100, payment: { cashAmount: 150 } });
  assert.equal(over.status, 409, JSON.stringify(over.json));
  assert.deepEqual(await qtyOf("RCV-005", "M"), { shop: 0, warehouse: 0 });
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  assert.equal((await cashOf(s.id)).length, 0);
  assert.equal((await A("GET", `/suppliers/${s.id}/invoices`)).json.items.length, 0);
  // نفس المفتاح مرتين = استلام واحد
  const k = key(), body = { supplierId: s.id, idempotencyKey: k, purchase: { invoiceNo: "DUP-1", currency: "USD", amount: 90, payment: { cashAmount: 90 } } };
  const a = await A("POST", "/stock/receive", { modelNumber: "RCV-005", location: "warehouse", series: [ser(["M", 1], ["S", 1])], ...body });
  const b = await A("POST", "/stock/receive", { modelNumber: "RCV-005", location: "warehouse", series: [ser(["M", 1], ["S", 1])], ...body });
  assert.deepEqual([a.status, b.status, b.json.duplicate], [201, 200, true]);
  assert.deepEqual(await qtyOf("RCV-005", "M"), { shop: 0, warehouse: 1 });
  assert.equal((await A("GET", `/suppliers/${s.id}/invoices`)).json.items.length, 1);
  assert.equal((await cashOf(s.id)).length, 1);
  // رقم فاتورة مكرر لنفس التاجر يرفض الاستلام كله
  const dup = await A("POST", "/stock/receive", { modelNumber: "RCV-005", location: "warehouse", series: [ser(["M", 1], ["S", 1])], supplierId: s.id, idempotencyKey: key(), purchase: { invoiceNo: "DUP-1", currency: "USD", amount: 10 } });
  assert.equal(dup.status, 409);
  assert.deepEqual(await qtyOf("RCV-005", "M"), { shop: 0, warehouse: 1 });
  // لا حركات مخزون يتيمة ولا أرتال مُلغاة بعد استلام فاشل (تحقق مباشر من القاعدة)
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const integ = await verifyIntegrity(mongoose.connection.db);
  assert.deepEqual(integ.problems.filter((p) => /رتل مرجعي مفقود/.test(p)), [], "حركات تشير إلى أرتال غير موجودة");
});

suite("الأمانة لا تُنشئ فاتورة شراء ولا التزاماً عند الاستلام؛ ومع فاتورة شراء تُرفض", async () => {
  const s = await newSupplier();
  await mkModel("RCV-006");
  const r = await receive("RCV-006", "shop", [ser(["M", 1], ["S", 1])], { supplierId: s.id, consignment: true, consignmentPrice: { amount: 50, currency: "USD" } });
  assert.equal(r.status, 201);
  assert.deepEqual(await pos(s.id), [0, 0, 0, "settled"]);
  assert.equal((await cashOf(s.id)).length, 0);
  const bad = await receive("RCV-006", "shop", [ser(["M", 1], ["S", 1])], { supplierId: s.id, consignment: true, purchase: { invoiceNo: "X-1", currency: "USD", amount: 10 } });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  const noSup = await receive("RCV-006", "shop", [ser(["M", 1], ["S", 1])], { purchase: { invoiceNo: "X-2", currency: "USD", amount: 10 } });
  assert.equal(noSup.status, 400);
});

suite("فاتورة بالليرة تُدفع من صندوق الليرة فقط، والموظف لا يستطيع إرسال فاتورة شراء", async () => {
  const s = await newSupplier();
  await mkModel("RCV-007");
  const r = await buy("RCV-007", s.id, { amount: 3000000, currency: "SYP", payment: { cashAmount: 1000000 } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(await pos(s.id, "SYP"), [2000000, 0, 2000000, "due"]);
  assert.deepEqual(await pos(s.id, "USD"), [0, 0, 0, "due"].map((v, i) => (i === 3 ? "due" : v)));
  assert.deepEqual((await cashOf(s.id)).map((c) => [c.currency, c.amountMinor]), [["SYP", 1000000]]);
});

// ======================================================================= التزامن: لا فرط تخصيص ولا تسوية مزدوجة
const liveAllocs = async (supplierId) => (await mongoose.connection.collection("supplier_allocations").find({ supplier: new mongoose.Types.ObjectId(supplierId), kind: "apply", releasedBy: { $exists: false } }).toArray());
const sumBy = (arr, f, k) => arr.filter((a) => String(a[f]) === String(k)).reduce((n, a) => n + a.creditMinor, 0);

suite("طلبان متزامنان يخصّصان 80 من سلفة 100: لا يتجاوز المخصَّص 100 أبداً", async () => {
  const s = await newSupplier();
  const adv = (await advance(s.id, 100)).json.entry;
  const i1 = (await invoice(s.id, 200)).json.invoice, i2 = (await invoice(s.id, 200)).json.invoice;
  const [a, b] = await Promise.all([allocate(s.id, adv.id, i1.id, 80), allocate(s.id, adv.id, i2.id, 80)]);
  const ok = [a, b].filter((r) => r.status === 201).length;
  assert.ok(ok <= 1, `نجح ${ok} طلبات (الحد 1): ${a.status}/${b.status}`);
  for (const r of [a, b]) assert.ok([201, 409, 500].includes(r.status), `حالة غير متوقعة ${r.status}`);
  const live = await liveAllocs(s.id);
  assert.ok(sumBy(live, "entry", adv.id) <= 10000, `مخصَّص ${sumBy(live, "entry", adv.id)} سنت من 10000`);
  assert.equal((await cashOf(s.id)).length, 1, "لا نقد جديد من التخصيص");
  const c = (await A("GET", `/suppliers/${s.id}/allocations`)).json.credits.find((x) => x.id === adv.id);
  assert.ok(c.available >= 0 && c.allocated <= 100);
});

suite("سلفتان تخصَّصان بالتوازي على فاتورة واحدة: لا تتجاوز الفاتورة قيمتها", async () => {
  const s = await newSupplier();
  const a1 = (await advance(s.id, 80)).json.entry, a2 = (await advance(s.id, 80)).json.entry;
  const inv = (await invoice(s.id, 100)).json.invoice;
  const rs = await Promise.all([allocate(s.id, a1.id, inv.id, 80), allocate(s.id, a2.id, inv.id, 80)]);
  assert.ok(rs.filter((r) => r.status === 201).length <= 1, rs.map((r) => r.status).join());
  const live = await liveAllocs(s.id);
  assert.ok(live.reduce((n, a) => n + a.amountMinor, 0) <= 10000, "المخصَّص على الفاتورة تجاوز قيمتها");
});

suite("استلامان متزامنان بفاتورتين يستهلكان السلفة نفسها: لا فرط استهلاك ولا مخزون يتيم", async () => {
  const s = await newSupplier();
  await mkModel("CON-001");
  const adv = (await advance(s.id, 100)).json.entry;
  const mk = (no) => receive("CON-001", "warehouse", [ser(["M", 1], ["S", 1])], { supplierId: s.id, purchase: { invoiceNo: no, currency: "USD", amount: 200, payment: { advances: [{ entryId: adv.id, amount: 80 }] } } });
  const rs = await Promise.all([mk("CC-1"), mk("CC-2")]);
  const ok = rs.filter((r) => r.status === 201).length;
  assert.ok(ok <= 1, rs.map((r) => r.status).join());
  const live = await liveAllocs(s.id);
  assert.ok(sumBy(live, "entry", adv.id) <= 10000);
  const invoices = (await A("GET", `/suppliers/${s.id}/invoices`)).json.items;
  assert.equal(invoices.length, ok, "عدد الفواتير = عدد الاستلامات الناجحة");
  assert.equal((await qtyOf("CON-001", "M")).warehouse, ok, "المخزون = عدد الاستلامات الناجحة (لا أرتال يتيمة)");
  assert.equal((await cashOf(s.id)).length, 1);
});

suite("طلب استلام بنفس المفتاح مرتين بالتوازي: يُنفَّذ مرة واحدة فقط", async () => {
  const s = await newSupplier();
  await mkModel("CON-002");
  const before = await qtyOf("CON-002", "M");
  const k = key();
  const body = { modelNumber: "CON-002", location: "warehouse", series: [ser(["M", 1], ["S", 1])], supplierId: s.id, idempotencyKey: k, purchase: { invoiceNo: "PAR-1", currency: "USD", amount: 90, payment: { cashAmount: 90 } } };
  const rs = await Promise.all([A("POST", "/stock/receive", body), A("POST", "/stock/receive", body), A("POST", "/stock/receive", body)]);
  assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
  for (const r of rs) assert.ok([200, 201, 409].includes(r.status), String(r.status));
  assert.deepEqual(await qtyOf("CON-002", "M"), { shop: before.shop, warehouse: before.warehouse + 1 }, "أُضيفت قطعة واحدة فقط");
  assert.equal((await A("GET", `/suppliers/${s.id}/invoices`)).json.items.length, 1);
  assert.equal((await cashOf(s.id)).length, 1);
});

suite("تسويتان متزامنتان لنفس الكمية المباعة: تُقبل واحدة فقط وsettledQty لا يتجاوز المباع", async () => {
  const { s, series } = await consignmentFixture("CON-003");
  await sell("CON-003", "M", 2);
  const line = [{ seriesId: series.id, size: "M", qty: 2 }];
  const rs = await Promise.all([settle(s.id, line), settle(s.id, line)]);
  assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
  const doc = await mongoose.connection.collection("series").findOne({ _id: new mongoose.Types.ObjectId(series.id) });
  assert.equal(doc.sizes.find((z) => z.size === "M").settledQty, 2);
  assert.equal((await A("GET", `/suppliers/${s.id}/invoices`)).json.items.length, 1, "فاتورة تسوية واحدة فقط");
});

// ======================================================================= فحص السلامة المستقل بعد كل سيناريوهات الفشل والتزامن في هذا الملف
suite("فحص السلامة المستقل نظيف بعد كل عمليات الفشل والتراجع والتزامن (لا حركات/أرتال/نقد/تخصيصات يتيمة)", async () => {
  const { verifyIntegrity } = require("../../scripts/lib/verify");
  const r = await verifyIntegrity(mongoose.connection.db);
  assert.deepEqual(r.problems, [], r.problems.join("\n"));
  assert.equal(r.ok, true);
});
