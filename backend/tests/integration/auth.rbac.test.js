/*
 * تكامل المصادقة والصلاحيات وسرّية الأرقام المالية على MongoDB حقيقي. تُشغَّل بـ:
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27017/poplar_test" npm run test:integration
 * تُفرَّغ قاعدة "<اسم>_rbac" بالكامل (اسمها يجب أن يحوي test).
 */
process.env.NODE_ENV = "test";
const RAW = process.env.MONGO_TEST_URI;
const URI = RAW ? RAW.replace(/\/([^/?]+)(\?|$)/, "/$1_rbac$2") : RAW;
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

const skip = !URI ? "MONGO_TEST_URI غير مضبوط: تُتخطّى الاختبارات التكاملية" : /test/i.test(URI) ? false : "اسم قاعدة الاختبار يجب أن يحتوي test";
const suite = (name, fn) => test(name, { skip }, fn);

let mongoose, server, base, admin, emp;
const call = async (s, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(s ? { Cookie: s.cookie, "x-csrf-token": s.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
};
const login = async (username, password) => {
  const r = await call(null, "POST", "/auth/login", { identifier: username, password });
  return r.status === 200 ? { cookie: r.headers.getSetCookie().find((c) => c.startsWith("poplar_sid=")).split(";")[0], csrf: r.json.csrfToken, json: r.json } : null;
};
const key = () => crypto.randomUUID();
const COST = 22.37, SELL = 45;
const keysDeep = (v, acc = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

test.before(async () => {
  if (skip) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  const names = ["productModel", "movement", "invoice", "return", "shipment", "counter", "setting", "series", "user", "session"];
  await Promise.all(names.map((m) => require(`../../src/models/${m}.model`)).map((m) => (m.init ? m.init() : m.Counter?.init?.())));
  const { createApp } = require("../../src/app");
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;

  const { hashPassword } = require("../../src/utils/password");
  const User = require("../../src/models/user.model");
  await User.create({ name: "المالك", username: "owner", passwordHash: await hashPassword("Owner-Test-Pass1"), role: "admin" });
  admin = await login("owner", "Owner-Test-Pass1");
  await call(admin, "PUT", "/settings", { usdToSyp: 14000 });
  const created = await call(admin, "POST", "/users", { name: "موظف", username: "clerk", password: "Blue-Test-Pass1x" });
  assert.equal(created.status, 201);
  emp = await login("clerk", "Blue-Test-Pass1x");
  emp.id = created.json.id;
});
test.after(async () => {
  if (skip) return;
  if (server) await new Promise((r) => server.close(r));
  if (mongoose) await mongoose.disconnect();
});

suite("الجلسات تُخزَّن مُجزَّأة، والمستخدم بلا كلمة مرور خام", async () => {
  const sessions = await mongoose.connection.collection("sessions").find().toArray();
  assert.ok(sessions.length >= 2);
  const raw = emp.cookie.split("=")[1];
  assert.ok(sessions.every((s) => s.sidHash !== raw && !JSON.stringify(s).includes(raw)));
  const users = await mongoose.connection.collection("users").find().toArray();
  assert.ok(users.every((u) => u.passwordHash.startsWith("scrypt$") && !JSON.stringify(u).includes("Test-Pass")));
});

suite("سيناريو كامل: المالك يشغّل المحاسبة، والموظف يعمل بلا أي رقم تكلفة أو ربح", async () => {
  // المالك: موديل بتكلفة، شحنة بتكلفة، نقل، بيع بخسارة، مرتجع تالف
  const m = await call(admin, "POST", "/models", { modelNumber: "RB-001", name: "Rbac Jeans", brand: "RB", origin: "local", type: "جينز", costPrice: COST, sellPrice: SELL, sizes: [{ size: "M" }] });
  assert.equal(m.status, 201);
  assert.equal(m.json.costPrice, COST);
  const rec = await call(admin, "POST", "/stock/receive", { modelNumber: "RB-001", location: "warehouse", idempotencyKey: key(), unitCostUsd: COST, series: [{ sizes: [{ size: "M", qty: 2 }] }, { sizes: [{ size: "M", qty: 2 }] }] });
  assert.equal(rec.status, 201);
  assert.equal((await call(admin, "POST", "/stock/transfer", { modelNumber: "RB-001", from: "warehouse", to: "shop", items: [{ size: "M", qty: 3 }] })).status, 200);
  const model = (await call(admin, "GET", "/models/RB-001")).json;
  const sizeId = model.sizes[0].id;

  // الموظف يرى الموديل بسعر البيع فقط
  const em = await call(emp, "GET", "/models/RB-001");
  assert.equal(em.status, 200);
  assert.equal(em.json.sellPrice, SELL);
  assert.ok(!("costPrice" in em.json));
  assert.equal(em.json.totals.shop, 3, "الكميات التشغيلية ظاهرة");
  const lookup = await call(emp, "GET", "/lookup?code=RB-001");
  assert.ok(!keysDeep(lookup.json).has("costPrice"));
  assert.ok(!keysDeep((await call(emp, "GET", "/models?q=RB")).json).has("costPrice"));

  // الموظف يبيع (الكاشير) بسعر أقل من التكلفة: ينجح، ولا يرى ربحاً ولا علامة below_cost
  const sale = await call(emp, "POST", "/invoices", { items: [{ modelId: model.id, sizeId, qty: 2, unitPrice: 10 }] });
  assert.equal(sale.status, 201);
  assert.equal(sale.json.totalPaid, 20);
  const saleKeys = keysDeep(sale.json);
  for (const k of ["costPrice", "costUsd", "profitUsd", "unitPriceUsd", "totalUsd", "flag"]) assert.ok(!saleKeys.has(k), `سرّب ${k}`);
  assert.ok(!JSON.stringify(sale.json).includes(String(COST)));

  // المالك: المحاسبة محفوظة كاملة في القاعدة وفي استجابته
  const inv = (await call(admin, "GET", `/invoices/${sale.json._id || sale.json.id}`)).json;
  assert.equal(inv.costUsd, COST * 2);
  assert.equal(inv.items[0].flag, "below_cost");
  assert.ok(inv.profitUsd < 0);
  assert.ok(inv.items[0].allocations?.length, "توزيع FIFO محفوظ");

  // قوائم وسجلات الموظف
  for (const p of ["/invoices", "/movements", "/series", "/reports/dashboard", "/returns"]) {
    const r = await call(emp, "GET", p);
    assert.equal(r.status, 200, p);
    const ks = keysDeep(r.json);
    for (const k of ["costPrice", "costUsd", "profitUsd", "unitCostUsd", "costValueUsd", "sellValueUsd", "unitPriceUsd", "flag"]) assert.ok(!ks.has(k), `${p} سرّب ${k}`);
    assert.ok(!JSON.stringify(r.json).includes(String(COST)), `${p} سرّب قيمة التكلفة`);
  }
  const a = await call(admin, "GET", "/movements");
  assert.ok(a.json.items.some((x) => x.costUsd > 0), "المالك يرى تكلفة الحركات");
  const d = (await call(admin, "GET", "/reports/dashboard")).json;
  assert.ok(d.totals.costValueUsd > 0);

  // مرتجع تالف بيد الموظف: يعمل، ولا تُسرَّب القيم المحاسبية
  const ret = await call(emp, "POST", "/returns", { invoiceId: sale.json._id || sale.json.id, items: [{ itemIndex: 0, qty: 1, condition: "damaged" }], mode: "cash" });
  assert.equal(ret.status, 201);
  const rk = keysDeep(ret.json);
  for (const k of ["reversedProfitUsd", "writeOffUsd", "fxDiffUsd", "refundUsd", "costPrice"]) assert.ok(!rk.has(k), `المرتجع سرّب ${k}`);
  const summary = (await call(admin, "GET", `/reports/summary?from=${new Date(Date.now() - 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`)).json;
  assert.ok(summary.returns.writeOffUsd > 0 || summary.damaged !== undefined, "المحاسبة الداخلية للمرتجع محسوبة");
  const stored = await mongoose.connection.collection("returns").findOne({});
  assert.equal(stored.writeOffUsd, COST, "قيمة الشطب مخزَّنة في القاعدة رغم حجبها عن الموظف");

  // تقارير المالك محظورة
  for (const p of ["/reports/summary?from=2020-01-01&to=2030-01-01", "/reports/inventory", "/users"]) assert.equal((await call(emp, "GET", p)).status, 403, p);
  assert.equal((await call(emp, "PUT", "/settings", { usdToSyp: 1 })).status, 403);
  assert.equal((await call(emp, "POST", "/stock/receive", { modelNumber: "RB-001", idempotencyKey: key(), unitCostUsd: 1, series: [{ sizes: [{ size: "M", qty: 1 }] }] })).status, 403);
  const empReceive = await call(emp, "POST", "/stock/receive", { modelNumber: "RB-001", location: "warehouse", idempotencyKey: key(), series: [{ sizes: [{ size: "M", qty: 1 }] }] });
  assert.equal(empReceive.status, 201, "الموظف يستلم شحنة دون تكلفة");
  assert.ok(!keysDeep(empReceive.json).has("costPrice"));
  assert.equal((await call(admin, "GET", "/models/RB-001")).json.costPrice, COST, "تكلفة الموديل لم تتغير");
});

suite("تعطيل الموظف أو تغيير صلاحياته يُسقط جلسته في القاعدة فعلاً", async () => {
  const s = await login("clerk", "Blue-Test-Pass1x");
  assert.equal((await call(s, "GET", "/auth/me")).status, 200);
  assert.equal((await call(admin, "PATCH", `/users/${emp.id}`, { active: false })).status, 200);
  assert.equal((await call(s, "GET", "/auth/me")).status, 401);
  assert.equal(await login("clerk", "Blue-Test-Pass1x"), null);
  assert.equal(await mongoose.connection.collection("sessions").countDocuments({ user: new mongoose.Types.ObjectId(emp.id) }), 0);
  await call(admin, "PATCH", `/users/${emp.id}`, { active: true });
  assert.ok(await login("clerk", "Blue-Test-Pass1x"));
});

suite("لا مسار ينشئ مالكاً: القاعدة تحوي مالكاً واحداً فقط", async () => {
  for (const body of [{ name: "x", username: "sneaky", password: "Sneaky-Pass-123a", role: "admin" }]) assert.equal((await call(admin, "POST", "/users", body)).status, 400);
  const fresh = await login("clerk", "Blue-Test-Pass1x");
  assert.equal((await call(fresh, "POST", "/users", { name: "x", username: "sneaky", password: "Sneaky-Pass-123a" })).status, 403);
  assert.equal(await mongoose.connection.collection("users").countDocuments({ role: "admin" }), 1);
});
