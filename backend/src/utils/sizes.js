const ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL", "5XL"];

const normalizeSize = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");

const rank = (s) => {
  const i = ORDER.indexOf(s);
  if (i >= 0) return [0, i];
  const n = parseFloat(s);
  return Number.isNaN(n) ? [2, 0] : [1, n];
};

// ترتيب منطقي للمقاسات: XS S M L XL ... ثم الأرقام تصاعدياً
const compareSizes = (a, b) => {
  const [ga, va] = rank(a);
  const [gb, vb] = rank(b);
  return ga - gb || va - vb || a.localeCompare(b);
};

module.exports = { normalizeSize, compareSizes };
