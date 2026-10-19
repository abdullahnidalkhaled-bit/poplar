// المصادقة والصلاحيات وسرّية البيانات المالية عبر HTTP، بلا قاعدة بيانات (المستودعان في الذاكرة).
process.env.NODE_ENV = "test";
process.env.LOGIN_MAX_ATTEMPTS = "5";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");
const mem = require("../helpers/memoryAuth");
const { RESTRICTED_KEYS } = require("../../src/middleware/redact");

mongoose.set("bufferTimeoutMS", 300);
const { createApp } = require("../../src/app");
const invoiceService = require("../../src/services/invoice.service");
const returnService = require("../../src/services/return.service");
const modelService = require("../../src/services/productModel.service");
const movementService = require("../../src/services/movement.service");
const reportService = require("../../src/services/report.service");
const seriesService = require("../../src/services/series.service");

let server, base, stores;
let adminS, empS;
const call = (method, path, opts) => mem.rawCall(base, method, path, opts);

test.before(async () => {
  stores = mem.install();
  server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  await mem.createUser({ username: "owner", role: "admin", name: "المالك" });
  await mem.createUser({ username: "emp1", role: "employee" });
  adminS = (await mem.login(base, "owner")).session;
  empS = (await mem.login(base, "emp1")).session;
});
test.after(() => new Promise((r) => server.close(r)));

// ------------------------------------------------------------------ المصادقة
test("بلا جلسة: كل مورد محمي يرد 401، و/health عام", async () => {
  const endpoints = [
    ["GET", "/models"], ["GET", "/models/FAF-001"], ["POST", "/models"], ["GET", "/lookup?code=x"], ["POST", "/qr/resolve"],
    ["GET", "/series"], ["GET", "/movements"], ["POST", "/stock/receive"], ["POST", "/stock/transfer"], ["POST", "/stock/damage"], ["POST", "/stock/adjust"],
    ["GET", "/invoices"], ["POST", "/invoices"], ["GET", "/returns"], ["POST", "/returns"],
    ["GET", "/reports/dashboard"], ["GET", "/reports/inventory"], ["GET", "/reports/summary"],
    ["GET", "/settings"], ["PUT", "/settings"], ["GET", "/users"], ["POST", "/users"], ["GET", "/auth/me"], ["POST", "/auth/logout"],
  ];
  for (const [m, p] of endpoints) {
    const r = await call(m, p, { body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.json.code, "UNAUTHENTICATED");
  }
  assert.equal((await call("GET", "/health")).status, 200);
});

test("الدخول الناجح: كوكي HttpOnly/SameSite=Strict/Path=/api، ولا هاش في الاستجابة", async () => {
  const r = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "OWNER", password: mem.PASSWORD } });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith("poplar_sid="));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/api/i);
  assert.equal(r.json.user.role, "admin");
  assert.ok(r.json.csrfToken);
  assert.ok(!/passwordHash|scrypt\$/.test(JSON.stringify(r.json)));
  assert.ok(![...stores.sessions.keys()].some((h) => cookie.includes(h)), "المعرّف الخام لا يُخزَّن");
});

test("بيانات خاطئة أو ناقصة أو حساب غير موجود/معطّل: رد عام موحّد دون كشف وجود الحساب", async () => {
  await mem.createUser({ username: "off", active: false });
  const wrong = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "owner", password: "wrong-password-1" } });
  const ghost = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "nobody", password: "wrong-password-1" } });
  const disabled = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "off", password: mem.PASSWORD } });
  for (const r of [wrong, ghost, disabled]) {
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "INVALID_CREDENTIALS");
    assert.equal(r.json.message, wrong.json.message);
    assert.ok(!r.headers.getSetCookie().length);
  }
  assert.equal((await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "owner" } })).status, 400);
  assert.equal((await mem.rawCall(base, "POST", "/auth/login", { body: {} })).status, 400);
  assert.equal((await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "owner", password: mem.PASSWORD, role: "admin" } })).status, 400, "حقول إضافية مرفوضة");
  assert.equal((await mem.rawCall(base, "POST", "/auth/login", { raw: "identifier=owner&password=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
});

test("تحديد معدل الدخول: محاولات فاشلة متكررة تُحظر 429", async () => {
  await mem.createUser({ username: "victim" });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "victim", password: "bad-password-123" } })).status);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[6], 429);
  const blocked = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "victim", password: mem.PASSWORD } });
  assert.equal(blocked.status, 429, "حتى كلمة المرور الصحيحة محظورة أثناء الحظر");
});

test("جلسة مستمرة: /auth/me يعيد المستخدم؛ كوكي مزيّف أو تالف 401", async () => {
  const me = await call("GET", "/auth/me", { session: adminS });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, "owner");
  assert.equal((await call("GET", "/auth/me", { session: { cookie: "poplar_sid=forged", csrf: "x" } })).status, 401);
  assert.equal((await call("GET", "/auth/me", { session: { cookie: "poplar_sid=%E0%A4%A", csrf: "x" } })).status, 401);
});

test("منع تثبيت الجلسة: الدخول مع كوكي قديم يُنهيه ويُصدر معرّفاً جديداً", async () => {
  const first = (await mem.login(base, "emp1")).session;
  const before = stores.sessions.size;
  const r = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "emp1", password: mem.PASSWORD }, headers: { Cookie: first.cookie } });
  const next = mem.parseSetCookie(r);
  assert.notEqual(next, first.cookie);
  assert.equal((await call("GET", "/auth/me", { session: { ...first } })).status, 401, "المعرّف القديم لم يعد صالحاً");
  assert.equal(stores.sessions.size, before, "أُزيلت واحدة وأُضيفت واحدة");
});

test("CSRF: التعديل بلا رمز أو برمز خاطئ مرفوض 403، والقراءة لا تحتاج رمزاً", async () => {
  const body = { items: [] };
  const none = await mem.rawCall(base, "POST", "/invoices", { body, headers: { Cookie: adminS.cookie } });
  assert.equal(none.status, 403);
  assert.equal(none.json.code, "CSRF_INVALID");
  const bad = await mem.rawCall(base, "POST", "/invoices", { body, session: { cookie: adminS.cookie, csrf: "wrong" } });
  assert.equal(bad.json.code, "CSRF_INVALID");
  const ok = await call("POST", "/invoices", { body, session: adminS });
  assert.equal(ok.status, 400, "تجاوز CSRF ووصل إلى التحقق");
  assert.equal((await mem.rawCall(base, "GET", "/auth/me", { headers: { Cookie: adminS.cookie } })).status, 200);
});

test("تسجيل الخروج يُبطل الجلسة فعلاً", async () => {
  const s = (await mem.login(base, "emp1")).session;
  assert.equal((await call("GET", "/auth/me", { session: s })).status, 200);
  assert.equal((await call("POST", "/auth/logout", { session: s })).status, 200);
  assert.equal((await call("GET", "/auth/me", { session: s })).status, 401, "الكوكي القديم لا يعمل بعد الخروج");
});

test("جلسة منتهية (خمول أو مطلقاً) تُرفض وتُحذف", async () => {
  const s = (await mem.login(base, "emp1")).session;
  const rec = [...stores.sessions.values()].at(-1);
  rec.lastSeenAt = new Date(Date.now() - 9 * 3600_000);
  assert.equal((await call("GET", "/auth/me", { session: s })).status, 401);
  const s2 = (await mem.login(base, "emp1")).session;
  [...stores.sessions.values()].at(-1).expiresAt = new Date(Date.now() - 1000);
  assert.equal((await call("GET", "/auth/me", { session: s2 })).status, 401);
});

// ------------------------------------------------------------------ الصلاحيات
test("الموظف: ممنوع (403) من كل ما هو للمالك، ومسموح له بالتشغيل اليومي", async () => {
  const forbidden = [
    ["POST", "/models", {}], ["PUT", "/models/FAF-001", {}], ["DELETE", "/models/FAF-001"], ["POST", "/models/FAF-001/restore", {}], ["GET", "/models/next-number?brand=FAF"],
    ["POST", "/stock/adjust", {}], ["POST", "/invoices/aaaaaaaaaaaaaaaaaaaaaaaa/cancel", {}],
    ["GET", "/reports/inventory"], ["GET", "/reports/summary"], ["PUT", "/settings", { usdToSyp: 1 }],
    ["GET", "/users"], ["POST", "/users", {}], ["PATCH", "/users/aaaaaaaaaaaaaaaaaaaaaaaa", {}], ["POST", "/users/aaaaaaaaaaaaaaaaaaaaaaaa/reset-password", {}],
  ];
  for (const [m, p, body] of forbidden) assert.equal((await call(m, p, { session: empS, body })).status, 403, `${m} ${p}`);

  // مسموحة: تتجاوز الصلاحية وتصل إلى التحقق (400) أو إلى القاعدة المفقودة (503) — لا 401/403
  const allowed = [
    ["GET", "/movements?limit=1000"], ["GET", "/series?limit=1000"], ["GET", "/models?status=weird"], ["GET", "/lookup?code="], ["POST", "/qr/resolve", {}],
    ["POST", "/stock/receive", {}], ["POST", "/stock/transfer", {}], ["POST", "/stock/damage", {}],
    ["POST", "/invoices", { items: [] }], ["GET", "/invoices/not-an-id"], ["POST", "/returns", {}], ["GET", "/reports/dashboard"], ["GET", "/settings"],
  ];
  for (const [m, p, body] of allowed) {
    const st = (await call(m, p, { session: empS, body })).status;
    assert.ok(![401, 403].includes(st), `${m} ${p} → ${st}`);
  }
});

test("المالك يتجاوز كل بوابات الصلاحيات", async () => {
  for (const [m, p, body] of [["POST", "/models", {}], ["POST", "/stock/adjust", {}], ["GET", "/reports/summary"], ["PUT", "/settings", { usdToSyp: -1 }], ["GET", "/users"], ["POST", "/stock/receive", {}]]) {
    const st = (await call(m, p, { session: adminS, body })).status;
    assert.ok(![401, 403].includes(st), `${m} ${p} → ${st}`);
  }
});

test("الموظف لا يستطيع إدخال تكلفة الشحنة: unitCostUsd مرفوض 403 صراحةً", async () => {
  const body = { modelNumber: "FAF-001", idempotencyKey: "abcdefgh-1", series: [{ sizes: [{ size: "M", qty: 1 }] }], unitCostUsd: 3 };
  const e = await call("POST", "/stock/receive", { session: empS, body });
  assert.equal(e.status, 403);
  assert.equal(e.json.code, "FORBIDDEN_FIELD");
  const a = await call("POST", "/stock/receive", { session: adminS, body: { ...body, series: [{ sizes: [{ size: "M", qty: 3 }] }] } });
  assert.equal(a.status, 400, "المالك يصل إلى التحقق");
});

test("صلاحيات الموظف الصريحة: المالك يمنح adjust فيعمل، ويُسحب فيسقط فوراً", async () => {
  const u = (await call("POST", "/users", { session: adminS, body: { name: "ليلى", username: "layla", password: "Blue-Pass-2024-a", permissions: ["models.read", "stock.adjust"] } })).json;
  const s = (await mem.login(base, "layla", "Blue-Pass-2024-a")).session;
  assert.ok(![401, 403].includes((await call("POST", "/stock/adjust", { session: s, body: {} })).status));
  assert.equal((await call("POST", "/invoices", { session: s, body: { items: [] } })).status, 403, "لم تُمنح invoices.create");
  await call("PATCH", `/users/${u.id}`, { session: adminS, body: { permissions: ["models.read"] } });
  assert.equal((await call("GET", "/auth/me", { session: s })).status, 401, "تغيير الصلاحيات يُسقط الجلسة");
});

// ------------------------------------------------------------------ إدارة الحسابات
test("المالك ينشئ موظفاً: الدور يُفرض employee ولا يُقبل من الطلب، ولا تُمنح صلاحيات المالك", async () => {
  const body = { name: "سعاد", username: "Souad", password: "Blue-Pass-2024-b" };
  const created = await call("POST", "/users", { session: adminS, body });
  assert.equal(created.status, 201);
  assert.equal(created.json.role, "employee");
  assert.equal(created.json.username, "souad");
  assert.ok(!JSON.stringify(created.json).includes("passwordHash"));
  assert.ok(!created.json.permissions.includes("costs.view"));
  assert.equal((await call("POST", "/users", { session: adminS, body: { ...body, username: "x1", role: "admin" } })).status, 400, "role مرفوض");
  assert.equal((await call("POST", "/users", { session: adminS, body: { ...body, username: "x2", permissions: ["costs.view"] } })).status, 400, "صلاحية مالك غير قابلة للمنح");
  assert.equal((await call("POST", "/users", { session: adminS, body: { ...body, username: "x3", password: "short" } })).status, 400, "كلمة ضعيفة");
  assert.equal((await call("POST", "/users", { session: adminS, body: { ...body, username: "x4", password: "abcdefghijkl" } })).status, 400, "بلا أرقام");
});

test("الموظف لا يرفع نفسه: لا مسار ولا حقل يغيّر الدور أو الصلاحيات", async () => {
  const me = (await call("GET", "/auth/me", { session: empS })).json.user;
  for (const [m, p, b] of [["PATCH", `/users/${me.id}`, { role: "admin" }], ["PATCH", `/users/${me.id}`, { permissions: ["costs.view"] }], ["POST", "/users", { name: "a", username: "evil", password: "Evil-Pass-2024", role: "admin" }]]) {
    assert.equal((await call(m, p, { session: empS, body: b })).status, 403, `${m} ${p}`);
  }
  assert.equal((await call("PUT", "/auth/me", { session: empS, body: { role: "admin" } })).status, 404);
  assert.equal((await call("GET", "/auth/me", { session: empS })).json.user.role, "employee");
  assert.equal((await call("POST", "/auth/change-password", { session: empS, body: { currentPassword: mem.PASSWORD, newPassword: "Another-Pass-77", role: "admin" } })).status, 400, "حقول إضافية");
});

test("حساب المالك محمي من واجهة الـ API: لا تعديل ولا تعطيل ولا إعادة ضبط", async () => {
  const owner = (await call("GET", "/auth/me", { session: adminS })).json.user;
  for (const [m, p, b] of [["PATCH", `/users/${owner.id}`, { active: false }], ["POST", `/users/${owner.id}/reset-password`, { password: "Hacker-Pass-2024" }]]) {
    const r = await call(m, p, { session: adminS, body: b });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "ADMIN_ACCOUNT_PROTECTED");
  }
});

test("تعطيل موظف يُسقط جلسته فوراً ويمنع دخوله، وإعادة التفعيل تعيد الدخول", async () => {
  const u = (await call("POST", "/users", { session: adminS, body: { name: "كمال", username: "kamal", password: "Blue-Pass-2024-c" } })).json;
  const s = (await mem.login(base, "kamal", "Blue-Pass-2024-c")).session;
  assert.equal((await call("GET", "/settings", { session: s })).status !== 401, true);
  assert.equal((await call("PATCH", `/users/${u.id}`, { session: adminS, body: { active: false } })).status, 200);
  assert.equal((await call("GET", "/auth/me", { session: s })).status, 401);
  assert.equal((await mem.login(base, "kamal", "Blue-Pass-2024-c")).res.status, 401);
  await call("PATCH", `/users/${u.id}`, { session: adminS, body: { active: true } });
  assert.equal((await mem.login(base, "kamal", "Blue-Pass-2024-c")).res.status, 200);
});

test("إعادة ضبط كلمة المرور تُسقط الجلسات وتُفعّل الجديدة فقط", async () => {
  const u = (await call("POST", "/users", { session: adminS, body: { name: "نور", username: "nour", password: "Blue-Pass-2024-d" } })).json;
  const s = (await mem.login(base, "nour", "Blue-Pass-2024-d")).session;
  assert.equal((await call("POST", `/users/${u.id}/reset-password`, { session: adminS, body: { password: "Green-Pass-2025-d" } })).status, 200);
  assert.equal((await call("GET", "/auth/me", { session: s })).status, 401);
  assert.equal((await mem.login(base, "nour", "Blue-Pass-2024-d")).res.status, 401);
  assert.equal((await mem.login(base, "nour", "Green-Pass-2025-d")).res.status, 200);
});

test("تغيير كلمة المرور الذاتي: الحالية مطلوبة، الجلسات الأخرى تسقط وتبقى الحالية بمعرّف جديد", async () => {
  await mem.createUser({ username: "pw1" });
  const a = (await mem.login(base, "pw1")).session;
  const b = (await mem.login(base, "pw1")).session;
  assert.equal((await call("POST", "/auth/change-password", { session: a, body: { currentPassword: "wrong-pass-123", newPassword: "Brand-New-Pass-9" } })).status, 401);
  const ok = await mem.rawCall(base, "POST", "/auth/change-password", { session: a, body: { currentPassword: mem.PASSWORD, newPassword: "Brand-New-Pass-9" } });
  assert.equal(ok.status, 200);
  const fresh = { cookie: mem.parseSetCookie(ok), csrf: ok.json.csrfToken };
  assert.equal((await call("GET", "/auth/me", { session: fresh })).status, 200);
  assert.equal((await call("GET", "/auth/me", { session: a })).status, 401);
  assert.equal((await call("GET", "/auth/me", { session: b })).status, 401);
});

// ------------------------------------------------------------------ سرّية البيانات المالية
// قيم فريدة مميّزة لتسهيل كشف أي تسريب في النص الخام
const S = { cost: 7771.11, profit: 8882.22, unitUsd: 5553.33, totalUsd: 4444.44, refundUsd: 3335.55, costVal: 9996.66, sellVal: 6667.77, ship: 1118.88 };
const fx = {
  model: () => ({ _id: "m1", modelNumber: "FAF-001", name: "n", brand: "FAF", origin: "local", type: "t", costPrice: S.cost, sellPrice: 45, sizes: [{ _id: "s1", size: "M", shopQty: 1, warehouseQty: 0 }] }),
  invoice: () => ({
    _id: "i1", number: 1, currency: "USD", totalPaid: 45, cashDue: 45, status: "completed", costUsd: S.cost, profitUsd: S.profit, totalUsd: S.totalUsd,
    items: [{ modelNumber: "FAF-001", size: "M", qty: 1, sellPrice: 45, unitPrice: 45, unitPriceUsd: S.unitUsd, costPrice: S.cost, flag: "below_cost", allocations: [{ seriesNo: "SER-000001", qty: 1 }] }],
  }),
  ret: () => ({ return: { number: 1, refundAmount: 45, cashRefund: 45, refundUsd: S.refundUsd, refundUsdToday: S.refundUsd, reversedProfitUsd: S.profit, writeOffUsd: S.cost, fxDiffUsd: S.ship, items: [{ qty: 1, unitPrice: 45, unitPriceUsd: S.unitUsd, costPrice: S.cost }] }, invoice: fx.invoice(), notRestocked: 0 }),
  movements: () => ({ items: [{ type: "sale", qty: 1, from: "shop", before: { shop: 2 }, after: { shop: 1 }, costUsd: S.ship }], total: 1 }),
  series: () => ({ series: { seriesNo: "SER-000001" }, movements: [{ type: "sale", qty: 1, costUsd: S.ship }] }),
  dashboard: () => ({ totals: { shop: 1, warehouse: 2, combined: 3, costValueUsd: S.costVal, sellValueUsd: S.sellVal }, counts: { restock: 0, transfer: 0 }, attention: [], recent: [{ type: "receive", qty: 1, costUsd: S.ship }] }),
};
const stubs = [
  [invoiceService, "getInvoice", fx.invoice], [invoiceService, "list", () => [fx.invoice()]], [invoiceService, "createInvoice", fx.invoice],
  [returnService, "createReturn", fx.ret], [returnService, "list", () => [fx.ret().return]],
  [modelService, "getDetail", fx.model], [modelService, "listModels", () => ({ items: [fx.model()], total: 1 })],
  [movementService, "list", fx.movements], [seriesService, "detail", fx.series], [reportService, "dashboard", fx.dashboard],
];
const requests = [
  ["GET", "/invoices/aaaaaaaaaaaaaaaaaaaaaaaa"], ["GET", "/invoices"],
  ["POST", "/invoices", { items: [{ modelId: "a".repeat(24), sizeId: "b".repeat(24), qty: 1, unitPrice: 45 }] }],
  ["POST", "/returns", { invoiceId: "a".repeat(24), items: [{ itemIndex: 0, qty: 1 }] }], ["GET", "/returns"],
  ["GET", "/models/FAF-001"], ["GET", "/models"], ["GET", "/movements"], ["GET", "/series/SER-000001"], ["GET", "/reports/dashboard"],
];

test("الموظف: لا مفتاح مالي سرّي ولا قيمة مميّزة في أي استجابة (بنود متداخلة، مجاميع، حركات)", async (t) => {
  const originals = stubs.map(([o, k]) => o[k]);
  stubs.forEach(([o, k, f]) => { o[k] = async () => f(); });
  t.after(() => stubs.forEach(([o, k], i) => { o[k] = originals[i]; }));

  const keysDeep = (v, acc = new Set()) => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
    return acc;
  };
  for (const [m, p, body] of requests) {
    const e = await call(m, p, { session: empS, body });
    assert.ok(e.status < 300, `${m} ${p} → ${e.status} ${JSON.stringify(e.json)}`);
    const keys = keysDeep(e.json);
    for (const k of RESTRICTED_KEYS) assert.ok(!keys.has(k), `${m} ${p} سرّب المفتاح ${k}`);
    const raw = JSON.stringify(e.json);
    for (const v of Object.values(S)) assert.ok(!raw.includes(String(v)), `${m} ${p} سرّب القيمة ${v}`);
  }
  // ما يحتاجه الموظف لإتمام البيع يبقى موجوداً
  const inv = (await call("GET", "/invoices/aaaaaaaaaaaaaaaaaaaaaaaa", { session: empS })).json;
  assert.equal(inv.totalPaid, 45);
  assert.equal(inv.items[0].unitPrice, 45);
  assert.equal(inv.items[0].sellPrice, 45);
  assert.equal(inv.items[0].allocations[0].seriesNo, "SER-000001");
  assert.equal((await call("GET", "/models/FAF-001", { session: empS })).json.sellPrice, 45);
  assert.equal((await call("GET", "/reports/dashboard", { session: empS })).json.totals.combined, 3, "إحصاءات التشغيل تبقى");

  // وللمالك كل شيء كما هو (المحاسبة لا تتأثر)
  const a = await call("GET", "/invoices/aaaaaaaaaaaaaaaaaaaaaaaa", { session: adminS });
  assert.equal(a.json.profitUsd, S.profit);
  assert.equal(a.json.items[0].costPrice, S.cost);
  assert.equal(a.json.items[0].flag, "below_cost");
  assert.equal((await call("GET", "/models/FAF-001", { session: adminS })).json.costPrice, S.cost);
  assert.equal((await call("GET", "/reports/dashboard", { session: adminS })).json.totals.costValueUsd, S.costVal);
  assert.equal((await call("POST", "/returns", { session: adminS, body: requests[3][2] })).json.return.reversedProfitUsd, S.profit);
});

test("الأخطاء لا تسرّب أسراراً: لا هاش ولا سر جلسة ولا مسارات داخلية", async () => {
  const r = await mem.rawCall(base, "POST", "/auth/login", { body: { identifier: "owner", password: "bad-password-1" } });
  const text = JSON.stringify(r.json);
  assert.ok(!/scrypt|passwordHash|secret|stack|node_modules/i.test(text), text);
});
