process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const responseMiddleware = require("../../src/middleware/response.middleware");
const present = require("../../src/middleware/present.middleware");
const presenters = require("../../src/middleware/presenters");
const { isOut, canTransfer } = require("../../src/utils/stock");

const fakeRes = () => {
  const res = { locals: {}, statusCode: 200, body: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
};
const withSuccess = (res) => responseMiddleware({}, res, () => {}) || res;

const rawModel = {
  _id: "m1", modelNumber: "FAF-001", name: "n", brand: "FAF", origin: "local", type: "t", costPrice: 1, sellPrice: 2,
  sizes: [{ _id: "s1", size: "M", shopQty: 0, warehouseQty: 3, barcode: "B1" }, { _id: "s2", size: "S", shopQty: 0, warehouseQty: 0 }],
};

test("res.success بلا عارض: يمرّر البيانات كما هي مع الحالة المطلوبة", () => {
  const res = fakeRes();
  withSuccess(res);
  res.success({ a: 1 }, 201);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { a: 1 });
  const ok = fakeRes();
  withSuccess(ok);
  ok.success([1]);
  assert.equal(ok.statusCode, 200);
});

test("present(name) يحدد العارض، وres.success يطبّقه عند جاهزية الاستجابة", () => {
  const res = fakeRes();
  withSuccess(res);
  present("model")({}, res, () => {});
  res.success(rawModel);
  assert.equal(res.body.id, "m1");
  const m = res.body.sizes.find((s) => s.size === "M");
  assert.deepEqual([m.availability, m.canTransfer, m.needsFactoryRestock], ["warehouse_only", true, false]);
  assert.equal(res.body.sizes.find((s) => s.size === "S").needsFactoryRestock, true);
  assert.deepEqual(res.body.totals, { shop: 0, warehouse: 3, combined: 3 });
});

test("عارض غير معروف يفشل عند تعريف المسار لا وقت الطلب", () => {
  assert.throws(() => present("nope"), /عارض غير معروف/);
});

test("عارضات القائمة والرمز ونتيجة المخزون", () => {
  const list = presenters.modelList({ items: [{ matchType: "name", ...rawModel }], page: 1, total: 1 });
  assert.equal(list.items[0].matchType, "name");
  assert.equal(list.items[0].totals.combined, 3);
  assert.equal(list.page, 1);

  const found = presenters.lookup({ kind: "size", model: rawModel, size: rawModel.sizes[0] });
  assert.equal(found.size.size, "M");
  assert.equal(found.size.availability, "warehouse_only");
  assert.equal(presenters.lookup({ kind: "model", model: rawModel }).model.modelNumber, "FAF-001");

  const stock = presenters.stockResult({ model: rawModel, duplicate: false, series: [{ seriesNo: "SER-000001" }] });
  assert.equal(stock.duplicate, false);
  assert.equal(stock.series[0].seriesNo, "SER-000001");
  assert.equal(stock.model.totals.warehouse, 3);
});

test("قاعدة المخزون المشتركة (utils/stock)", () => {
  assert.equal(isOut(0, 0), true);
  assert.equal(isOut(1, 0), false);
  assert.equal(canTransfer(0, 2), true);
  assert.equal(canTransfer(1, 2), false);
  assert.equal(canTransfer(0, 0), false);
});
