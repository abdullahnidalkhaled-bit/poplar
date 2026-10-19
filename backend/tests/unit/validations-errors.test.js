process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ZodError } = require("zod");
const model = require("../../src/validations/productModel.validation");
const stock = require("../../src/validations/stock.validation");
const movement = require("../../src/validations/movement.validation");
const errorHandler = require("../../src/middleware/errorHandler");
const { conflict } = require("../../src/utils/errors");

const validModel = { name: "FAF Bootcut Trousers", brand: "FAF", origin: "local", type: "بنطال", cut: "بوت كات", costPrice: 20, sellPrice: 45, sizes: [{ size: "s" }, { size: "m" }] };

test("إنشاء موديل: مدخلات صحيحة تُطبَّع (مقاس/رقم موديل)", () => {
  const out = model.create.body.parse({ ...validModel, modelNumber: " faf-001 " });
  assert.equal(out.modelNumber, "FAF-001");
  assert.deepEqual(out.sizes.map((x) => x.size), ["S", "M"]);
  assert.equal(model.create.body.parse({ ...validModel, modelNumber: "" }).modelNumber, undefined, "الفارغ = توليد تلقائي");
});

test("إنشاء موديل: يرفض سالب/عشري/حقول مجهولة/بلا مقاسات/رقم غير صالح", () => {
  const bad = (patch) => assert.throws(() => model.create.body.parse({ ...validModel, ...patch }), ZodError);
  bad({ sizes: [{ size: "S", shopQty: 1 }] });  // الكميات لم تعد على المقاس: تأتي من أرتال
  bad({ sizes: [] });
  bad({ color: "red" });           // حقل اللون محذوف
  bad({ modelNumber: "bad id" });
  bad({ origin: "mars" });
  bad({ costPrice: -1 });
  bad({ name: "   " });
});

test("الاستلام: يتطلب مفتاح idempotency وأرتالاً صالحة (1 أو 2 لكل مقاس)", () => {
  const ok = { modelNumber: "faf-001", series: [{ sizes: [{ size: "m", qty: 2 }, { size: "xs", qty: 1 }] }], idempotencyKey: "abcdefgh-1" };
  const out = stock.receive.body.parse(ok);
  assert.equal(out.location, "warehouse");
  assert.equal(out.modelNumber, "FAF-001");
  assert.deepEqual(out.series[0].sizes.map((x) => x.size), ["M", "XS"]);
  const bad = (patch) => assert.throws(() => stock.receive.body.parse({ ...ok, ...patch }), ZodError);
  bad({ idempotencyKey: undefined });
  bad({ location: "street" });
  bad({ series: [] });
  bad({ series: [{ sizes: [] }] });                              // رتل فارغ
  bad({ series: [{ sizes: [{ size: "S", qty: 3 }] }] });          // أكثر من قطعتين
  bad({ series: [{ sizes: [{ size: "S", qty: 0 }] }] });
  bad({ series: [{ sizes: [{ size: "S", qty: 1.5 }] }] });
  bad({ series: [{ sizes: [{ size: "S", qty: 1 }, { size: "s", qty: 1 }] }] }); // مقاس مكرر
  bad({ items: [{ size: "M", qty: 1 }] });                        // الصيغة القديمة مرفوضة
  // نفس المقاس في أرتال مختلفة مسموح ومجموعه قد يتجاوز 2
  assert.doesNotThrow(() => stock.receive.body.parse({ ...ok, series: [{ sizes: [{ size: "S", qty: 2 }] }, { sizes: [{ size: "S", qty: 2 }] }] }));
  // رسالة الرفض عربية وقابلة للتنفيذ
  try { stock.receive.body.parse({ ...ok, series: [{ sizes: [{ size: "S", qty: 3 }] }] }); } catch (e) { assert.match(e.issues[0].message, /قطعتين.*S/); }
});

test("الجرد والتالف: يرفض الكمية السالبة ويتطلب سبباً", () => {
  assert.throws(() => stock.adjust.body.parse({ modelNumber: "FAF-001", size: "M", location: "shop", newQty: -1, reason: "x" }), ZodError);
  assert.throws(() => stock.damage.body.parse({ modelNumber: "FAF-001", size: "M", location: "shop", qty: 1, reason: "" }), ZodError);
  assert.doesNotThrow(() => stock.adjust.body.parse({ modelNumber: "FAF-001", size: "M", location: "shop", newQty: 0, reason: "جرد" }));
});

test("استعلام السجل: حدود الصفحة والترتيب المسموح فقط", () => {
  assert.throws(() => movement.list.query.parse({ limit: "500" }), ZodError);
  assert.throws(() => movement.list.query.parse({ sort: "password" }), ZodError);
  assert.equal(movement.list.query.parse({ page: "2", limit: "10", type: "sale" }).page, 2);
});

// ------------------------------------------------ معالج الأخطاء المركزي
const run = (err) => {
  let out;
  const res = { headersSent: false, status(c) { this.code = c; return this; }, json(b) { out = { status: this.code, ...b }; } };
  errorHandler(err, { id: "req-1", path: "/x" }, res, () => {});
  return out;
};

test("معالج الأخطاء: تحقق، تطبيقي، تكرار، وغير متوقع بلا تسريب", () => {
  let zerr;
  try { model.create.body.parse({}); } catch (e) { zerr = e; }
  const v = run(zerr);
  assert.equal(v.status, 400);
  assert.equal(v.code, "VALIDATION_ERROR");
  assert.ok(v.errors.length > 0);

  assert.deepEqual([run(conflict("تعارض", "X")).status, run(conflict("تعارض", "X")).code], [409, "X"]);

  const dup = Object.assign(new Error("E11000 duplicate key collection: secret.db index: modelNumber_1"), { code: 11000, keyPattern: { modelNumber: 1 } });
  const d = run(dup);
  assert.equal(d.status, 409);
  assert.equal(d.code, "MODEL_NUMBER_TAKEN");
  assert.ok(!d.message.includes("secret"));

  const boom = run(new Error("connect ECONNREFUSED mongodb://user:PASSWORD@host/db at /srv/app/secret.js:12"));
  assert.equal(boom.status, 500);
  assert.equal(boom.message, "حدث خطأ غير متوقع في الخادم.");
  assert.ok(!JSON.stringify(boom).includes("PASSWORD") && !JSON.stringify(boom).includes("secret.js") && !("stack" in boom));
  assert.equal(boom.requestId, "req-1");
});
