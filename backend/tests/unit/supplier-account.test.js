// منطق حسابات التجار الخالص بالوحدة الصغرى الأصلية لكل عملة (دولار/ليرة): لا جمع ولا تحويل بين العملتين
const test = require("node:test");
const assert = require("node:assert/strict");
const acct = require("../../src/utils/supplierAccount");
const { toMinorC, fromMinorC, validAmount, isCents } = require("../../src/utils/money");

let n = 0;
// قيد بعملته الأصلية: amount بالوحدة الكبرى -> وحدة صغرى صحيحة
const E = (type, amount, currency = "USD", extra = {}) => {
  const amountMinor = toMinorC(currency, amount);
  return { _id: `e${++n}`, type, currency, amount, amountMinor, signedMinor: acct.signedMinor(type, amountMinor), ...extra };
};
const A = (entry, invoice, amount, extra = {}) => {
  const inv = toMinorC(invoice.currency, amount);
  return { _id: `a${++n}`, kind: "apply", entry: entry._id, invoice: invoice._id, currency: invoice.currency, amountMinor: inv, creditCurrency: entry.currency, creditMinor: inv, ...extra };
};
const INV = (amount, currency = "USD", extra = {}) => ({ _id: `i${++n}`, status: "posted", currency, amount, amountMinor: toMinorC(currency, amount), invoiceDate: new Date("2026-01-01"), ...extra });
const pos = (s, c) => [fromMinorC(c, s[c].grossMinor), fromMinorC(c, s[c].advanceMinor), fromMinorC(c, s[c].netMinor)];

test("اصطلاح الإشارة: شراء/تسوية مدينة موجبان، والدفعة/السلفة/الإشعار/المرتجع سالبة", () => {
  assert.equal(acct.signedMinor("purchase", 1000), 1000);
  assert.equal(acct.signedMinor("adjustment", 1000), 1000);
  for (const t of ["payment", "advance", "credit", "return_credit"]) assert.equal(acct.signedMinor(t, 1000), -1000);
  assert.throws(() => acct.signedMinor("reversal", 1000));
});

test("وحدات العملتين: الدولار بالسنت، والليرة ليرة كاملة، وتحقق الدقة", () => {
  assert.equal(toMinorC("USD", 19.99), 1999);
  assert.equal(toMinorC("USD", 0.1 + 0.2), 30);
  assert.equal(toMinorC("SYP", 9000000), 9000000);
  assert.equal(fromMinorC("USD", 1999), 19.99);
  assert.equal(fromMinorC("SYP", 450000), 450000);
  assert.ok(validAmount("USD", 10.25) && !validAmount("USD", 10.255) && validAmount("SYP", 1500) && !validAmount("SYP", 1500.5) && !validAmount("USD", NaN));
  assert.ok(isCents(0.1) && !isCents(0.001));
});

test("A: فاتورة 1000$ ودفعة 1000$ مخصّصة = مسدد بالكامل", () => {
  const i = INV(1000), pur = E("purchase", 1000, "USD", { invoice: i._id }), pay = E("payment", 1000, "USD", { invoice: i._id });
  const s = acct.summarize([pur, pay], [A(pay, i, 1000)], [i]);
  assert.deepEqual(pos(s, "USD"), [0, 0, 0]);
  assert.equal(s.status, "settled");
});

test("B: فاتورة 1000$ ودفعة 600$ = مستحق إجمالي 400 (due)", () => {
  const i = INV(1000), pur = E("purchase", 1000, "USD", { invoice: i._id }), pay = E("payment", 600, "USD", { invoice: i._id });
  const alloc = [A(pay, i, 600)];
  const s = acct.summarize([pur, pay], alloc, [i]);
  assert.deepEqual(pos(s, "USD"), [400, 0, 400]);
  assert.equal(s.status, "due");
  const st = acct.invoiceStates([i], alloc, [pur, pay]).get(i._id);
  assert.deepEqual([st.allocatedMinor, st.outstandingMinor, st.payStatus], [60000, 40000, "partial"]);
});

test("C: سلفة 500$ + فاتورة 300$ غير مخصّصة = مستحق 300 وسلفة 500 معاً (mixed)، والصافي -200؛ بعد التخصيص سلفة 200", () => {
  const adv = E("advance", 500), i = INV(300), pur = E("purchase", 300, "USD", { invoice: i._id });
  let s = acct.summarize([adv, pur], [], [i]);
  assert.deepEqual(pos(s, "USD"), [300, 500, -200]);
  assert.equal(s.status, "mixed", "الصافي سالب لا يُخفي المستحق ولا السلفة");
  const alloc = [A(adv, i, 300)];
  s = acct.summarize([adv, pur], alloc, [i]);
  assert.deepEqual(pos(s, "USD"), [0, 200, -200]);
  assert.equal(s.status, "advance");
  assert.equal(acct.creditStates([adv, pur], alloc, [i])[0].availableMinor, 20000);
});

test("صافي الصفر مع مستحق وسلفة متساويين يبقى mixed لا settled", () => {
  const adv = E("advance", 300), i = INV(300), pur = E("purchase", 300, "USD", { invoice: i._id });
  const s = acct.summarize([adv, pur], [], [i]);
  assert.equal(s.USD.netMinor, 0);
  assert.equal(s.status, "mixed");
});

test("الليرة والدولار حسابان مستقلان تماماً: لا جمع ولا تحويل ولا مقاصّة بينهما", () => {
  const entries = [E("purchase", 1000000, "SYP"), E("purchase", 100, "USD"), E("advance", 50, "USD")];
  const s = acct.summarize(entries, [], []);
  assert.deepEqual(pos(s, "SYP"), [1000000, 0, 1000000]);
  assert.deepEqual(pos(s, "USD"), [100, 50, 50]);
  assert.equal(s.status, "mixed");
  // سلفة بالدولار لا تُنقص مستحق الليرة، ومستحق الدولار لا يُنقص سلفة الليرة
  const only = acct.summarize([E("purchase", 500000, "SYP"), E("advance", 1000, "USD")], [], []);
  assert.deepEqual(pos(only, "SYP"), [500000, 0, 500000]);
  assert.deepEqual(pos(only, "USD"), [0, 1000, -1000]);
});

test("تخصيص عبر العملتين صريح: يستهلك من رصيد بعملته ويسدّد فاتورة بعملتها، ولا يمسّ العملة الثالثة", () => {
  const advUsd = E("advance", 30, "USD"), iS = INV(600000, "SYP"), pur = E("purchase", 600000, "SYP", { invoice: iS._id });
  const cross = { _id: "x1", kind: "apply", entry: advUsd._id, invoice: iS._id, currency: "SYP", amountMinor: 300000, creditCurrency: "USD", creditMinor: 3000, crossCurrency: true, rate: 10000 };
  const s = acct.summarize([advUsd, pur], [cross], [iS]);
  assert.deepEqual(pos(s, "SYP"), [300000, 0, 300000]);
  assert.deepEqual(pos(s, "USD"), [0, 0, 0]);
  assert.equal(acct.invoiceStates([iS], [cross], [advUsd, pur]).get(iS._id).outstandingMinor, 300000);
  assert.equal(acct.creditStates([advUsd, pur], [cross], [iS])[0].availableMinor, 0);
});

test("D: التزام 1000$، دفعة 600$، ائتمان إرجاع 100$ مخصّص = المستحق 300", () => {
  const i = INV(1000), pur = E("purchase", 1000, "USD", { invoice: i._id }), pay = E("payment", 600, "USD", { invoice: i._id }), rc = E("return_credit", 100, "USD", { invoice: i._id });
  const s = acct.summarize([pur, pay, rc], [A(pay, i, 600), A(rc, i, 100)], [i]);
  assert.deepEqual(pos(s, "USD"), [300, 0, 300]);
});

test("الدقة: مئة قيد بـ 0.10$ لا تنتج أخطاء فاصلة عائمة", () => {
  const entries = Array.from({ length: 100 }, () => E("purchase", 0.1));
  assert.equal(acct.summarize(entries, [], []).USD.grossMinor, 1000);
});

test("القيد المعكوس وعكسه لا يُعدّان مرتين ولا يغيّران المركز المالي", () => {
  const i = INV(1000), pur = E("purchase", 1000, "USD", { invoice: i._id });
  const pay = E("payment", 400, "USD", { reversedBy: "r1" });
  const rev = { _id: "r1", type: "reversal", currency: "USD", amount: 400, amountMinor: 40000, signedMinor: 40000, reverses: pay._id };
  const s = acct.summarize([pur, pay, rev], [], [i]);
  assert.deepEqual(pos(s, "USD"), [1000, 0, 1000]);
  assert.equal(s.USD.creditsMinor, 0);
});

test("سجلات الإصدار السابق (قيم دولارية بلا حقول أصلية) تُقرأ بعملتها الأصلية دون تحويل", () => {
  const legacy = { _id: "l1", type: "purchase", currency: "SYP", amount: 9000000, rate: 15000, usdMinor: 60000, deltaMinor: 60000 }; // مكافئ دولاري قديم
  assert.equal(acct.amountMinorOf(legacy), 9000000, "المبلغ الأصلي بالليرة لا المكافئ الدولاري");
  assert.equal(acct.signedMinorOf(legacy), 9000000);
  const legacyUsd = { _id: "l2", type: "payment", currency: "USD", amount: 12.5, deltaMinor: -1250 };
  assert.equal(acct.amountMinorOf(legacyUsd), 1250);
  assert.equal(acct.signedMinorOf(legacyUsd), -1250);
});

test("الرصيد الجاري لكل عملة بحسابها المستقل", () => {
  const rows = acct.withRunningBalance([E("advance", 500, "USD"), E("purchase", 1000000, "SYP"), E("purchase", 300, "USD"), E("payment", 200000, "SYP")]);
  assert.deepEqual(rows.map((r) => [r.currency, r.balance]), [["USD", -500], ["SYP", 1000000], ["USD", -200], ["SYP", 800000]]);
});

test("خطة التطبيق التلقائي: بنفس العملة فقط، الأقدم على الأقدم دون تجاوز", () => {
  const i1 = INV(100, "USD", { invoiceDate: new Date("2026-01-01") }), i2 = INV(200, "USD", { invoiceDate: new Date("2026-02-01") }), iS = INV(900000, "SYP");
  const adv = E("advance", 250, "USD", { date: new Date("2026-01-05") });
  const entries = [E("purchase", 100, "USD", { invoice: i1._id }), E("purchase", 200, "USD", { invoice: i2._id }), E("purchase", 900000, "SYP", { invoice: iS._id }), adv];
  const plan = acct.planAutoAllocation([i2, i1, iS], entries, [], null);
  assert.deepEqual(plan.map((p) => [p.invoice._id, p.amountMinor]), [[i1._id, 10000], [i2._id, 15000]], "لا يُخصَّص دولار على فاتورة ليرة");
  assert.equal(acct.planAutoAllocation([i1, i2], [adv], [A(adv, i1, 100), A(adv, i2, 150)], null).length, 0);
});

test("التخصيص المحرَّر أو المعلَّم للمراجعة لا يُحسب", () => {
  const adv = E("advance", 100), i = INV(100);
  const live = A(adv, i, 100), released = A(adv, i, 100, { releasedBy: "x" }), review = A(adv, i, 100, { needsReview: true });
  assert.equal(acct.allocationTotals([live, released, review]).byInvoice.get(i._id), 10000);
});

test("حالات الحساب الأربع", () => {
  assert.equal(acct.statusOf(false, false), "settled");
  assert.equal(acct.statusOf(true, false), "due");
  assert.equal(acct.statusOf(false, true), "advance");
  assert.equal(acct.statusOf(true, true), "mixed");
});
