import test from "node:test";
import assert from "node:assert/strict";
import { usd, syp, money } from "../src/utils.js";

test("USD: موجب وصفر وسالب (الإشارة قبل الرمز)", () => {
  assert.equal(usd(1042), "$1,042.00");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(undefined), "$0.00");
  assert.equal(usd(-1042), "-$1,042.00");
  assert.equal(usd(-0.5), "-$0.50");
  assert.equal(usd(-0.001), "$0.00");
  assert.equal(usd(1234567.891), "$1,234,567.89");
});

test("SYP: بلا كسور، الإشارة كما هي", () => {
  assert.equal(syp(19540000), "19,540,000 ل.س");
  assert.equal(syp(-21060000), "-21,060,000 ل.س");
  assert.equal(syp(0), "0 ل.س");
});

test("money يوزّع حسب العملة", () => {
  assert.equal(money(-1042, "USD"), "-$1,042.00");
  assert.equal(money(-1042, "SYP"), "-1,042 ل.س");
});
