// الموظفون والرواتب (واجهة): تسميات وتحقق خفيف فقط. كل المبالغ والإجماليات (الاستحقاق والمتبقي والتسويات والسلف) تأتي من الخادم
// (GET /employees/:id/payroll-summary) ولا تُحسب هنا؛ هذه الدوال لا تغني عن تحقق الخادم، وغايتها رسالة أوضح قبل الإرسال.

export const SALARY_CATEGORY = "رواتب";
export const EMP_STATUS = { active: "على رأس العمل", inactive: "موقوف", terminated: "منتهي الخدمة" };
export const PERIOD_STATUS = { draft: "مفتوحة", approved: "معتمدة", partially_paid: "مدفوعة جزئياً", paid: "مدفوعة", closed: "مغلقة" };
export const INDICATOR = { none: "لا فترة", pending: "مفتوحة", approved: "معتمدة", partially_paid: "مدفوعة جزئياً", paid: "مدفوعة", overdue: "متأخرة", closed: "مغلقة" };
export const INDICATOR_TONE = { none: "muted", pending: "warn", approved: "info", partially_paid: "warn", paid: "ok", overdue: "danger", closed: "muted" };
export const ADVANCE_STATUS = { pending: "غير مصروفة", disbursed: "مصروفة", partially_settled: "مسوّاة جزئياً", settled: "مسوّاة", cancelled: "ملغاة", reversed: "معكوسة" };
export const LEDGER_TYPE = {
  salary_entitlement: "استحقاق راتب", advance_disbursement: "صرف سلفة", advance_settlement: "تسوية سلفة", salary_payment: "دفعة راتب",
  allowance: "بدل", bonus: "مكافأة", deduction: "استقطاع", adjustment: "ترحيل / إعادة إسناد سلفة", reversal: "قيد عكسي",
};
export const LEDGER_STATE = { posted: "مرحَّل", reversed: "معكوس", reversal: "قيد عكسي" };
export const ADJUST_KIND = { allowance: "بدل", bonus: "مكافأة", deduction: "استقطاع" };
// سبب تعذّر دفع الراتب كما يعيده الخادم
export const PAY_BLOCK = {
  NO_SALARY_DUE: "لا يوجد راتب مستحق لهذه الفترة (مدفوع بالكامل أو مسدَّد بخصم السلف).",
  PERIOD_CLOSED: "فترة هذا الشهر مغلقة ولا تقبل دفعات جديدة.",
  FUTURE_PERIOD: "لا يُدفع راتب فترة مستقبلية.",
  EMPLOYEE_INACTIVE: "الموظف غير فعّال.",
  BEFORE_HIRE: "هذا الشهر قبل شهر تعيين الموظف.",
  HISTORICAL_SALARY_UNKNOWN: "لا يمكن إنشاء فترة لهذا الشهر: الراتب الحالي لا يصلح أساساً لشهر أقدم من سريانه المعروف.",
  INACTIVE_ADVANCE_CARRY: "الموظف غير فعّال وسلفته أكبر من راتبه المتبقي فلا يمكن ترحيلها؛ يلزم قرار إداري. السلفة تبقى ظاهرة في رصيده.",
};

// الشهر الحالي يأتي من الخادم دائماً (UTC): لا يُحسب في المتصفح كي لا يختلف عن الخادم عند حدود الأشهر
export const isPeriodKey = (k) => /^\d{4}-(0[1-9]|1[0-2])$/.test(k || "");
export const OPEN_PERIOD = ["draft", "approved", "partially_paid"];
export const openPeriods = (periods = []) => periods.filter((p) => OPEN_PERIOD.includes(p.status));

// تحقق المبلغ قبل الإرسال: عدد صحيح بالليرة، وخانتان عشريتان كحد أقصى بالدولار. يعيد رسالة أو ""
export function validateAmount(currency, text, { max } = {}) {
  const raw = String(text ?? "").trim();
  if (raw === "") return "المبلغ مطلوب";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "أدخل رقماً صحيحاً";
  if (n <= 0) return "المبلغ يجب أن يكون أكبر من صفر";
  if (currency === "SYP" && !Number.isInteger(n)) return "مبلغ الليرة عدد صحيح";
  if (currency !== "SYP" && !/^\d+(\.\d{1,2})?$/.test(raw)) return "خانتان عشريتان كحد أقصى";
  if (max != null && n > max) return `المبلغ يتجاوز المتبقي المستحق (${max})`;
  return "";
}

// حالة نموذج مصروف الراتب انطلاقاً من ملخص الخادم: لا يحسب أي رصيد، يقرأه فقط
export function salaryFormState(summary, amountText) {
  if (!summary) return { ready: false, error: "", full: false, blocked: "" };
  if (!summary.canPay) return { ready: false, error: "", full: false, blocked: PAY_BLOCK[summary.reason] || "لا يمكن دفع راتب لهذه الفترة." };
  const error = validateAmount(summary.currency, amountText, { max: summary.remainingPayable });
  const n = Number(amountText);
  return { ready: !error, error, full: !error && n === summary.remainingPayable, partial: !error && n < summary.remainingPayable, blocked: "" };
}

// الإجراء الرئيسي في حساب الموظف دائماً «دفع الراتب» ما دام ممكناً؛ وإلا يُبيَّن السبب
export const dueText = (d) => (d ? new Date(d).toLocaleDateString("en-GB") : "—");
