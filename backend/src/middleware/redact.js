// حجب البيانات المالية السرية على الخادم قبل أن تغادر الاستجابة. يعمل على كل res.success تلقائياً،
// فلا يعتمد الأمن على أن ينتبه كل مسار جديد لاستدعائه. المفاتيح تُحذف على أي عمق (بنود الفواتير، الحركات المضمّنة، التجميعات...).
//
// للموظف مسموح: sellPrice (سعر البيع) وunitPrice وtotalPaid وcashDue وrefundAmount (ما يدفعه الزبون/يُرد له) وسعر الصرف.
// محجوب: التكلفة والربح والقيم المالية الداخلية بالدولار ومؤشرات الخسارة.
const RESTRICTED_KEYS = new Set([
  "costPrice", "costUsd", "unitCostUsd",
  "profitUsd", "reversedProfitUsd", "reversedProfit", "writeOffUsd", "fxDiffUsd",
  "unitPriceUsd", "totalUsd", "refundUsd", "refundUsdToday",
  "costValueUsd", "sellValueUsd",
  "flag", "flags", "belowCost",
]);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    const plain = typeof value.toJSON === "function" ? value.toJSON() : value;
    if (plain !== value) return redact(plain);
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!RESTRICTED_KEYS.has(k)) out[k] = redact(v);
    return out;
  }
  return value;
}

module.exports = { redact, RESTRICTED_KEYS };
