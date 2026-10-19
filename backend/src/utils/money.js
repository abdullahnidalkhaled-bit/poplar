const round = (n, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};

const convert = (amount, from, to, rate) => {
  if (from === to) return amount;
  return from === "SYP" ? amount / rate : amount * rate;
};

// علامة التنبيه: هل بيع القطعة بخسارة أو بأقل من سعر البيع المحدد؟ (الأسعار بالدولار)
const computeFlag = (priceUsd, costUsd, sellUsd, currency, rate) => {
  const eps = currency === "SYP" && rate > 0 ? 0.5 / rate + 1e-9 : 0.005;
  if (priceUsd < costUsd - eps) return "below_cost";
  if (priceUsd < sellUsd - eps) return "below_sell_price";
  return "normal";
};

// الدولار بالسنت (عدد صحيح) لحسابات حسابات التجار: كل الجمع والمقارنة على الأعداد الصحيحة
const toMinor = (n) => Math.round((Number(n) + Number.EPSILON) * 100);
const fromMinor = (m) => Math.round(m) / 100;
const isCents = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

// وحدة صغرى حسب العملة: الدولار بالسنت، والليرة السورية ليرة كاملة. كل الحساب على أعداد صحيحة
const toMinorC = (cur, n) => (cur === "SYP" ? Math.round(Number(n)) : toMinor(n));
const fromMinorC = (cur, m) => (cur === "SYP" ? Math.round(m) : Math.round(m) / 100);
const validAmount = (cur, n) => typeof n === "number" && Number.isFinite(n) && (cur === "SYP" ? Number.isInteger(n) : isCents(n));

module.exports = { round, convert, computeFlag, toMinor, fromMinor, isCents, toMinorC, fromMinorC, validAmount };
