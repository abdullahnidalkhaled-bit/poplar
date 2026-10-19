// اختبارات HTTP لا تحتاج قاعدة بيانات: التحقق، الأمان، رموز QR، وعدم تسريب الأخطاء
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");
const mem = require("../helpers/memoryAuth");
const { createApp } = require("../../src/app");

let server, base, session;
test.before(async () => {
  mongoose.set("bufferTimeoutMS", 300); // فشل سريع لأي استعلام (لا قاعدة بيانات هنا)
  mem.install();
  await mem.createUser({ username: "owner", role: "admin" });
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  session = (await mem.login(base, "owner")).session; // هذه الاختبارات تفحص التحقق/الأخطاء كمالك مسجَّل
});
test.after(async () => {
  await new Promise((r) => server.close(r));
});

const call = async (method, path, body, raw) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: session.cookie, "x-csrf-token": session.csrf }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
};

test("health يعمل وبلا ترويسة x-powered-by، وترويسات الأمان موجودة", async () => {
  const r = await call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.ok(r.headers.get("content-security-policy"));
  assert.ok(r.headers.get("x-content-type-options"));
  assert.ok(r.headers.get("x-request-id"));
});

test("مسار غير موجود: 404 بصيغة JSON", async () => {
  const r = await call("GET", "/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "NOT_FOUND");
});

test("إنشاء موديل غير صالح: 400 برسالة عربية وقائمة أخطاء", async () => {
  const r = await call("POST", "/models", { name: "", brand: "FAF", origin: "local", type: "x", costPrice: -1, sellPrice: 1, sizes: [] });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "VALIDATION_ERROR");
  assert.ok(r.json.errors.length >= 2);
  assert.match(r.json.message, /بيانات غير صالحة/);
});

test("حقل مجهول (اللون المحذوف) يُرفض", async () => {
  const r = await call("POST", "/models", { name: "a", brand: "b", origin: "local", type: "t", costPrice: 1, sellPrice: 2, sizes: [{ size: "S" }], color: "red" });
  assert.equal(r.status, 400);
});

test("كميات سالبة/عشرية في الاستلام والنقل مرفوضة قبل أي وصول للقاعدة", async () => {
  const base_ = { modelNumber: "FAF-001", idempotencyKey: "abcdefgh-1", location: "warehouse" };
  assert.equal((await call("POST", "/stock/receive", { ...base_, items: [{ size: "S", qty: -2 }] })).status, 400);
  assert.equal((await call("POST", "/stock/receive", { ...base_, items: [{ size: "S", qty: 1.5 }] })).status, 400);
  assert.equal((await call("POST", "/stock/receive", { modelNumber: "FAF-001", items: [{ size: "S", qty: 1 }] })).status, 400, "بلا idempotencyKey");
  assert.equal((await call("POST", "/stock/transfer", { modelNumber: "FAF-001", from: "shop", to: "x", items: [{ size: "S", qty: 1 }] })).status, 400);
  assert.equal((await call("POST", "/stock/adjust", { modelNumber: "FAF-001", size: "S", location: "shop", newQty: -1, reason: "x" })).status, 400);
});

test("QR: حمولة غير صالحة أو قديمة تعطي رسالة واضحة (بلا قاعدة بيانات)", async () => {
  const a = await call("POST", "/qr/resolve", { payload: "garbage" });
  assert.equal(a.status, 400);
  assert.equal(a.json.code, "INVALID_QR");
  const b = await call("POST", "/qr/resolve", { payload: "PLP9:FAF-001" });
  assert.equal(b.json.code, "OBSOLETE_QR");
  const c = await call("GET", "/lookup?code=PLP1:@@@");
  assert.equal(c.json.code, "INVALID_QR");
});

test("بارامترات غير صالحة: صفحة/حد/ترتيب/تاريخ/معرّف", async () => {
  assert.equal((await call("GET", "/movements?limit=1000")).status, 400);
  assert.equal((await call("GET", "/movements?sort=password")).status, 400);
  assert.equal((await call("GET", "/movements?from=notadate&to=x")).status, 400);
  assert.equal((await call("GET", "/models?status=weird")).status, 400);
  assert.equal((await call("GET", "/invoices/not-an-id")).status, 400);
  assert.equal((await call("GET", "/lookup?code=")).status, 400);
  assert.equal((await call("GET", "/models/bad%20number")).status, 400);
});

test("JSON فاسد: 400 وليس 500", async () => {
  const r = await call("POST", "/models", null, "{bad json");
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_JSON");
});

test("عند غياب قاعدة البيانات: 503 برسالة عامة دون تسريب تفاصيل داخلية", async () => {
  const r = await call("GET", "/models/FAF-001");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "DB_UNAVAILABLE");
  const text = JSON.stringify(r.json);
  assert.ok(!/mongo|stack|node_modules|at /i.test(text), text);
});
