// حسابات التجار: حارس الصلاحية والمصادقة وCSRF والتحقق عبر HTTP بلا قاعدة بيانات
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");
const mem = require("../helpers/memoryAuth");

mongoose.set("bufferTimeoutMS", 300);
const { createApp } = require("../../src/app");
const { PERMISSIONS, ADMIN_ONLY, GRANTABLE, effectivePermissions } = require("../../src/config/permissions");

let server, base, adminS, empS;
const call = (method, path, opts) => mem.rawCall(base, method, path, opts);
const ID = "64b64c4f2f9c4a3b8c1d2e3f";

const ENDPOINTS = [
  ["GET", "/suppliers/summary"], ["GET", "/suppliers"], ["POST", "/suppliers"], ["GET", `/suppliers/${ID}`], ["PATCH", `/suppliers/${ID}`],
  ["GET", `/suppliers/${ID}/ledger`], ["GET", `/suppliers/${ID}/invoices`], ["POST", `/suppliers/${ID}/invoices`],
  ["POST", `/suppliers/${ID}/payments`], ["POST", `/suppliers/${ID}/advances`], ["POST", `/suppliers/${ID}/adjustments`],
  ["POST", `/suppliers/${ID}/entries/${ID}/reverse`], ["GET", `/suppliers/${ID}/allocations`], ["POST", `/suppliers/${ID}/allocations`], ["POST", `/suppliers/${ID}/allocations/auto`], ["POST", `/suppliers/${ID}/allocations/${ID}/release`],
  ["GET", `/suppliers/${ID}/settlements`], ["GET", `/suppliers/${ID}/settlements/eligible`], ["POST", `/suppliers/${ID}/settlements`], ["POST", `/suppliers/${ID}/settlements/${ID}/reverse`], ["POST", `/suppliers/${ID}/consignment/prices`],
  ["GET", `/suppliers/${ID}/consignment`], ["GET", `/suppliers/${ID}/returns`], ["POST", `/suppliers/${ID}/returns`],
];

test.before(async () => {
  mem.install();
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  await mem.createUser({ username: "owner", role: "admin", name: "المالك" });
  // حتى لو خُزّنت الصلاحية على الموظف مباشرة فإنها لا تُمنح (ADMIN_ONLY)
  await mem.createUser({ username: "emp1", role: "employee", permissions: [...GRANTABLE, "suppliers.manage"] });
  adminS = (await mem.login(base, "owner")).session;
  empS = (await mem.login(base, "emp1")).session;
});
test.after(() => new Promise((r) => server.close(r)));

test("suppliers.manage للمالك فقط ولا يمكن منحها لموظف", () => {
  assert.ok(PERMISSIONS.includes("suppliers.manage"));
  assert.ok(ADMIN_ONLY.includes("suppliers.manage"));
  assert.ok(!GRANTABLE.includes("suppliers.manage"));
  assert.ok(effectivePermissions({ role: "admin" }).includes("suppliers.manage"));
  assert.ok(!effectivePermissions({ role: "employee", permissions: ["suppliers.manage", "models.read"] }).includes("suppliers.manage"));
});

test("بلا جلسة: كل مسارات التجار ترد 401", async () => {
  for (const [m, p] of ENDPOINTS) {
    const r = await call(m, p, { body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.json.code, "UNAUTHENTICATED");
  }
});

test("الموظف يتلقى 403 على كل مسارات التجار (قراءة وكتابة) حتى لو خُزّنت له الصلاحية", async () => {
  for (const [m, p] of ENDPOINTS) {
    const r = await call(m, p, { session: empS, body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.code, "FORBIDDEN");
  }
});

test("المالك بلا رمز CSRF يرد 403 CSRF_INVALID على الكتابة", async () => {
  const r = await call("POST", "/suppliers", { body: { name: "تاجر" }, headers: { Cookie: adminS.cookie } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "CSRF_INVALID");
});

test("المالك: التحقق الصارم يرفض الحقول المجهولة والقيم غير الصالحة (قبل لمس القاعدة)", async () => {
  const bad = [
    ["POST", "/suppliers", { name: "تاجر", role: "admin" }],
    ["POST", "/suppliers", { name: "" }],
    ["POST", `/suppliers/${ID}/payments`, { amount: -5, currency: "USD", idempotencyKey: "abcdefgh1" }],
    ["POST", `/suppliers/${ID}/payments`, { amount: 5, currency: "EUR", idempotencyKey: "abcdefgh1" }],
    ["POST", `/suppliers/${ID}/payments`, { amount: 5, idempotencyKey: "short" }],
    ["POST", `/suppliers/${ID}/advances`, { amount: 5, idempotencyKey: "abcdefgh1", extra: 1 }],
    ["POST", `/suppliers/${ID}/adjustments`, { kind: "credit", amount: 5, idempotencyKey: "abcdefgh1" }], // السبب إلزامي
    ["POST", `/suppliers/${ID}/returns`, { items: [], reason: "x", idempotencyKey: "abcdefgh1" }],
    ["POST", `/suppliers/${ID}/returns`, { items: [{ seriesId: ID, size: "M", qty: 0 }], reason: "x", idempotencyKey: "abcdefgh1" }],
    ["POST", `/suppliers/${ID}/entries/${ID}/reverse`, { reason: "" }],
    ["POST", `/suppliers/${ID}/allocations`, { entryId: ID, invoiceId: ID, amount: 0, idempotencyKey: "abcdefgh1" }],
    ["POST", `/suppliers/${ID}/settlements`, { items: [], idempotencyKey: "abcdefgh1" }],
    ["POST", `/suppliers/${ID}/consignment/prices`, { seriesIds: [ID], price: { amount: 0 }, reason: "x" }],
    ["POST", `/suppliers/${ID}/consignment/prices`, { seriesIds: [ID], price: { amount: 5 } }],
    ["GET", "/suppliers/not-an-id", undefined],
  ];
  for (const [m, p, body] of bad) {
    const r = await call(m, p, { session: adminS, body });
    assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(body)}`);
    assert.equal(r.json.code, "VALIDATION_ERROR");
  }
});

test("استلام الشحنة: ربط تاجر/أمانة محجوب عن الموظف برفض صريح، وأمانة بلا تاجر مرفوضة", async () => {
  const body = { modelNumber: "FAF-001", idempotencyKey: "abcdefgh1", series: [{ sizes: [{ size: "M", qty: 1 }] }] };
  const e1 = await call("POST", "/stock/receive", { session: empS, body: { ...body, supplierId: ID } });
  assert.equal(e1.status, 403);
  assert.equal(e1.json.code, "FORBIDDEN_FIELD");
  const e2 = await call("POST", "/stock/receive", { session: empS, body: { ...body, consignment: true } });
  assert.equal(e2.status, 403);
  const a = await call("POST", "/stock/receive", { session: adminS, body: { ...body, consignment: true } });
  assert.equal(a.status, 400);
  assert.equal(a.json.code, "VALIDATION_ERROR");
});

// ------------------------------------------------------------------ المالية (الصندوقان والمصروفات): للمالك فقط
const FIN = [
  ["GET", "/finance/dashboard?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"], ["GET", "/finance/cash"], ["POST", "/finance/cash"], ["POST", `/finance/cash/${ID}/reverse`],
  ["GET", "/finance/expenses"], ["POST", "/finance/expenses"], ["POST", `/finance/expenses/${ID}/reverse`],
];

test("المالية: 401 بلا جلسة و403 للموظف على كل المسارات", async () => {
  for (const [m, p] of FIN) {
    const r = await call(m, p, { body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${p}`);
    const e = await call(m, p, { session: empS, body: m === "GET" ? undefined : {} });
    assert.equal(e.status, 403, `${m} ${p}`);
  }
});

test("المالية: التحقق الصارم من العملة والمبلغ والحقول المجهولة قبل لمس القاعدة", async () => {
  const bad = [
    ["POST", "/finance/cash", { currency: "EUR", direction: "in", amount: 5, note: "x", idempotencyKey: "abcdefgh1" }],
    ["POST", "/finance/cash", { currency: "USD", direction: "sideways", amount: 5, note: "x", idempotencyKey: "abcdefgh1" }],
    ["POST", "/finance/cash", { currency: "USD", direction: "in", amount: -5, note: "x", idempotencyKey: "abcdefgh1" }],
    ["POST", "/finance/cash", { currency: "USD", direction: "in", amount: 5, note: "x", idempotencyKey: "abcdefgh1", usdEquivalent: 5 }],
    ["POST", "/finance/expenses", { currency: "SYP", amount: 0, category: "x", idempotencyKey: "abcdefgh1" }],
    ["POST", "/finance/expenses", { currency: "SYP", amount: 5, idempotencyKey: "abcdefgh1" }],
    ["POST", `/finance/expenses/${ID}/reverse`, { reason: "" }],
    ["GET", "/finance/dashboard", undefined],
    ["POST", `/suppliers/${ID}/payments`, { amount: 5, currency: "USD", crossCurrency: { settlesAmount: 1 }, idempotencyKey: "abcdefgh1" }], // سعر الصرف مطلوب مع التأكيد
    ["POST", `/suppliers/${ID}/allocations`, { entryId: ID, invoiceId: ID, amount: 5, rate: 0, idempotencyKey: "abcdefgh1" }],
  ];
  for (const [m, p, body] of bad) {
    const r = await call(m, p, { session: adminS, body });
    assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(body)}`);
    assert.equal(r.json.code, "VALIDATION_ERROR");
  }
});
