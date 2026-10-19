process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSeriesComposition, totalOf, summarizeSizesText, formatSeriesNo } = require("../../src/utils/series");
const seriesV = require("../../src/validations/series.validation");

test("رتل صالح بقطعة واحدة لكل مقاس", () => {
  assert.deepEqual(validateSeriesComposition([{ size: "XS", qty: 1 }, { size: "S", qty: 1 }]), []);
});

test("رتل صالح بقطعتين لكل مقاس + مقاسات مخصصة", () => {
  const sizes = [{ size: "XS", qty: 1 }, { size: "S", qty: 2 }, { size: "M", qty: 2 }, { size: "L", qty: 1 }, { size: "XL", qty: 2 }, { size: "XXL", qty: 1 }, { size: "38", qty: 2 }, { size: "3XL", qty: 1 }];
  assert.deepEqual(validateSeriesComposition(sizes), []);
  assert.equal(totalOf(sizes), 12);
});

test("يرفض 3 قطع أو أكثر من مقاس واحد برسالة واضحة", () => {
  const [e] = validateSeriesComposition([{ size: "S", qty: 3 }]);
  assert.match(e, /قطعتين/);
  assert.match(e, /S/);
  assert.ok(validateSeriesComposition([{ size: "S", qty: 10 }]).length > 0);
});

test("يرفض الرتل الفارغ وصفر القطع وغير الصحيح والمكرر", () => {
  assert.ok(validateSeriesComposition([]).length > 0);
  assert.ok(validateSeriesComposition(undefined).length > 0);
  assert.ok(validateSeriesComposition([{ size: "S", qty: 0 }]).length > 0);
  assert.ok(validateSeriesComposition([{ size: "S", qty: -1 }]).length > 0);
  assert.ok(validateSeriesComposition([{ size: "S", qty: 1.5 }]).length > 0);
  assert.ok(validateSeriesComposition([{ size: "S", qty: 1 }, { size: "s", qty: 1 }]).length > 0);
});

test("القاعدة لكل رتل لا لكل موديل: أرتال متعددة بنفس المقاس مقبولة", () => {
  const a = [{ size: "S", qty: 2 }];
  const b = [{ size: "S", qty: 2 }];
  assert.deepEqual(validateSeriesComposition(a), []);
  assert.deepEqual(validateSeriesComposition(b), []);
  assert.equal(totalOf(a) + totalOf(b), 4);
});

test("ملخص المقاسات ورقم الرتل", () => {
  assert.equal(summarizeSizesText([{ size: "L", qty: 2 }, { size: "XS", qty: 1 }, { size: "M", qty: 0 }]), "XS: 1, L: 2");
  assert.equal(formatSeriesNo(7), "SER-000007");
});

test("استعلام سجل الأرتال: ترتيب وفلاتر مسموحة فقط", () => {
  assert.throws(() => seriesV.list.query.parse({ sort: "password" }));
  assert.throws(() => seriesV.list.query.parse({ limit: "1000" }));
  assert.equal(seriesV.list.query.parse({ location: "shop", page: "2" }).page, 2);
  assert.throws(() => seriesV.detail.params.parse({ seriesNo: "x" }));
  assert.equal(seriesV.detail.params.parse({ seriesNo: "SER-000123" }).seriesNo, "SER-000123");
});
