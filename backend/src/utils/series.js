// قواعد الرتل (Series) الخالصة: مصدر الحقيقة الوحيد لتركيبه عند الإنشاء. بلا قاعدة بيانات.
const { SERIES_MIN_PER_SIZE, SERIES_MAX_PER_SIZE, SIZE_REGEX } = require("../config/constants");
const { normalizeSize, compareSizes } = require("./sizes");

const totalOf = (sizes) => (sizes || []).reduce((n, s) => n + (Number(s.qty) || 0), 0);

/**
 * يتحقق من تركيب رتل جديد: [{ size, qty }]
 * يعيد قائمة أخطاء (فارغة = صالح) برسائل عربية قابلة للتنفيذ.
 * القاعدة تخص الرتل الواحد فقط: لا حد عالمياً على مجموع المقاس عبر الأرتال.
 */
function validateSeriesComposition(sizes) {
  const errors = [];
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return ["الرتل فارغ: أضف مقاساً واحداً على الأقل بكمية 1 أو 2."];
  }
  const seen = new Set();
  for (const s of sizes) {
    const name = normalizeSize(s.size);
    if (!SIZE_REGEX.test(name)) errors.push(`المقاس "${s.size}" غير صالح.`);
    if (seen.has(name)) errors.push(`المقاس ${name} مكرر داخل الرتل نفسه: ادمج الكميات في بند واحد.`);
    seen.add(name);
    const q = s.qty;
    if (!Number.isInteger(q)) errors.push(`كمية المقاس ${name} يجب أن تكون عدداً صحيحاً.`);
    else if (q < SERIES_MIN_PER_SIZE) errors.push(`كمية المقاس ${name} يجب أن تكون ${SERIES_MIN_PER_SIZE} أو ${SERIES_MAX_PER_SIZE}؛ احذف المقاس إن لم يكن ضمن الرتل.`);
    else if (q > SERIES_MAX_PER_SIZE) errors.push(`الرتل لا يقبل أكثر من ${SERIES_MAX_PER_SIZE} قطعتين من المقاس ${name} (المُدخل ${q}). أنشئ رتلاً آخر للباقي.`);
  }
  return errors;
}

// ملخص نصي مرتّب: "XS: 1, S: 2"
function summarizeSizesText(sizes) {
  return [...(sizes || [])]
    .filter((s) => s.qty > 0)
    .sort((a, b) => compareSizes(a.size, b.size))
    .map((s) => `${s.size}: ${s.qty}`)
    .join(", ");
}

const formatSeriesNo = (n) => `SER-${String(n).padStart(6, "0")}`;

module.exports = { validateSeriesComposition, totalOf, summarizeSizesText, formatSeriesNo };
