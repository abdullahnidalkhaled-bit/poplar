// ثوابت المجال المشتركة بين كل الطبقات
module.exports = Object.freeze({
  LOCATIONS: ["shop", "warehouse"],
  ORIGINS: ["foreign", "local"],
  CURRENCIES: ["USD", "SYP"],
  MOVEMENT_TYPES: ["sale", "receive", "transfer", "return", "return_damaged", "damaged", "adjust", "cancel", "supplier_return"],
  // ملكية الأرتال: owned = مملوكة (مشتراة)، consignment = بضاعة أمانة لتاجر (برسم الأمانة)
  OWNERSHIPS: ["owned", "consignment"],
  // الصندوقان المستقلان: عملة الحركة الفعلية تحدد الصندوق. لا جمع ولا تحويل بينهما
  CASH_TYPES: ["sale_receipt", "sale_cancellation", "customer_refund", "supplier_payment", "supplier_advance", "supplier_reversal", "expense", "expense_reversal", "deposit", "withdrawal", "reversal",
    "employee_advance", "salary_payment", "payroll_reversal"],
  // قيود دفتر التاجر: شراء/تسوية مدينة (تزيد المستحق) · دفعة/سلفة/إشعار دائن/مرتجع (تخفضه) · عكس
  // حالات حساب التاجر: settled | due (مستحقات فقط) | advance (سلفة فقط) | mixed (الاثنان معاً)
  SUPPLIER_ENTRY_TYPES: ["purchase", "adjustment", "payment", "advance", "credit", "return_credit", "reversal"],
  // رقم الموديل: أحرف كبيرة وأرقام وشرطة، يبدأ بحرف أو رقم، 2 إلى 32 خانة
  MODEL_NUMBER_REGEX: /^[A-Z0-9][A-Z0-9._-]{1,31}$/,
  // المقاس: S, XL, 2XL, 38, 40.5 ...
  SIZE_REGEX: /^[A-Z0-9][A-Z0-9./-]{0,9}$/,
  QR_PREFIX: "PLP",
  QR_VERSION: 1,
  DEFAULT_SIZES: ["S", "M", "L", "XL"],
  // الرواتب والسلف: كل الحسابات بالوحدة الصغرى الصحيحة وبعملة الموظف. لا جمع ولا تحويل بين العملتين
  EMPLOYEE_STATUSES: ["active", "inactive", "terminated"],
  PAYROLL_STATUSES: ["draft", "approved", "partially_paid", "paid", "closed"],
  ADVANCE_STATUSES: ["pending", "disbursed", "partially_settled", "settled", "cancelled", "reversed"],
  PAYROLL_LEDGER_TYPES: ["salary_entitlement", "advance_disbursement", "advance_settlement", "salary_payment", "allowance", "bonus", "deduction", "adjustment", "reversal"],
  // فئة المصروف التي تدفع الرواتب: تتطلب موظفاً وتمرّ عبر خدمة الرواتب نفسها (مصدر وحيد للحساب)
  SALARY_EXPENSE_CATEGORY: "رواتب",
  MAX_PAGE_SIZE: 100,
  // الأرتال (Series): received = استلام فعلي (يخضع لقاعدة 1-2)، derived = ما نُقل جزئياً من رتل آخر،
  // balance = رصيد قديم مُرحَّل أو زيادات جرد (لا يخضع لقاعدة 1-2)
  SERIES_KINDS: ["received", "derived", "balance"],
  SERIES_STATUSES: ["active", "depleted"],
  SERIES_MIN_PER_SIZE: 1,
  SERIES_MAX_PER_SIZE: 2,
  MAX_SERIES_PER_RECEIVE: 20,
});
