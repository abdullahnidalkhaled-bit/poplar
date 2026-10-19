// الحساب الوحيد المعتمد للرواتب (كل شيء أعداد صحيحة بالوحدة الصغرى؛ لا فاصلة عائمة):
//   الصافي المستحق (net)  = الراتب الأساسي + البدلات + المكافآت − الاستقطاعات المعتمدة
//   المتبقي للدفع          = الصافي − تسويات السلف المطبَّقة على الفترة − دفعات الراتب
// السلفة المصروفة ليست خصماً من الراتب بحد ذاتها: لا تُخصم إلا بقيد تسوية (advance_settlement) صريح.
// نفس المعادلة تُكتب مرة ثانية كتعبير MongoDB في repositories/payroll.repository.js (statusStage / remainingExpr)
// لتُفرض ذرّياً داخل قاعدة البيانات؛ اختبارات الوحدة تتحقق من تطابقهما.

const { normalizeText } = require("./text");

// فئة الراتب: أي كتابة مكافئة («الرواتب»، «راتب»، «salary»…) تُعامَل كفئة الرواتب (تتطلب موظفاً) ولا تتحول بصمت إلى مصروف عادي
const SALARY_VARIANTS = new Set(["رواتب", "الرواتب", "راتب", "الراتب", "رواتب الموظفين", "رواتب العاملين", "salary", "salaries", "payroll"].map(normalizeText));
const isSalaryCategory = (c) => SALARY_VARIANTS.has(normalizeText(String(c || "")));

const monthOf = (d) => (d ? new Date(d).toISOString().slice(0, 7) : null);
/**
 * أهلية إنشاء فترة راتب لشهر معيّن (لا تخترع لقطة راتب تاريخية):
 *  - BEFORE_HIRE: قبل شهر التعيين (إن كان تاريخ التعيين مسجّلاً).
 *  - HISTORICAL_SALARY_UNKNOWN: قبل الشهر الذي يُعرف منه أن الراتب الحالي ساري (salaryEffectiveFrom، وإلا شهر إنشاء السجل):
 *    الراتب الحالي لا يصلح أساساً لشهر أقدم منه. يلزم تصريح صريح من المالك (salaryEffectiveFrom على سجل الموظف).
 */
function eligibilityReason(employee, key) {
  const hire = monthOf(employee.hireDate);
  if (hire && key < hire) return "BEFORE_HIRE";
  const since = employee.salaryEffectiveFrom || monthOf(employee.createdAt);
  if (since && key < since) return "HISTORICAL_SALARY_UNKNOWN";
  return null;
}

const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

const netEntitlement = (p) => p.baseSalaryMinor + (p.allowancesMinor || 0) + (p.bonusesMinor || 0) - (p.deductionsMinor || 0);
const remainingPayable = (p) => netEntitlement(p) - (p.settledMinor || 0) - (p.paidMinor || 0);
const advanceOutstanding = (a) => a.amountMinor - (a.settledMinor || 0);

// الحالة المشتقة بعد اعتماد الفترة (المسودة والمغلقة لا تُشتق)
function derivedStatus(p) {
  if (p.status === "draft" || p.status === "closed") return p.status;
  if (remainingPayable(p) === 0) return "paid";
  return (p.settledMinor || 0) + (p.paidMinor || 0) > 0 ? "partially_paid" : "approved";
}

// الانتقالات المسموحة للإجراءات الصريحة (الحالات الجزئية/المدفوعة تُشتق من الدفعات والتسويات لا تُحدَّد يدوياً)
const OPEN_FOR_SETTLEMENT = ["draft", "approved", "partially_paid"];
const OPEN_FOR_PAYMENT = ["approved", "partially_paid"];
const OPEN_FOR_REVERSAL = ["draft", "approved", "partially_paid", "paid"];
const canTransition = (from, action) => {
  if (action === "approve") return from === "draft";
  if (action === "close") return from === "paid";
  return false;
};

// حدود الفترة من مفتاحها (UTC): البداية أول الشهر، النهاية آخره، والاستحقاق يوم payDay (1..28)
function periodBounds(key, payDay = 1) {
  if (!PERIOD_KEY.test(key)) throw new Error("INVALID_PERIOD_KEY");
  const [y, m] = key.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  const dueDate = new Date(Date.UTC(y, m - 1, Math.min(Math.max(payDay, 1), 28)));
  return { start, end, dueDate };
}

// مؤشر العرض: pending (مسودة) | approved | partially_paid | paid | overdue (مستحق ولم يُسدَّد) | closed
function indicator(p, now = new Date()) {
  if (!p) return "none";
  if (p.status === "closed") return "closed";
  if (p.status === "draft") return "pending";
  if (p.status !== "paid" && new Date(p.dueDate) < now && remainingPayable(p) > 0) return "overdue";
  return p.status;
}

// أثر كل نوع قيد على عدّادات الفترة (للتحقق من الاتساق: عدّادات الفترة = مجموع قيودها غير المعكوسة)
const COUNTER_OF = { allowance: "allowancesMinor", bonus: "bonusesMinor", deduction: "deductionsMinor", advance_settlement: "settledMinor", salary_payment: "paidMinor" };

// يعيد حساب عدّادات الفترة من قيود دفترها (القيد المعكوس وقيد العكس يُستبعدان معاً)
function countersFromLedger(entries) {
  const out = { allowancesMinor: 0, bonusesMinor: 0, deductionsMinor: 0, settledMinor: 0, paidMinor: 0 };
  for (const e of entries) {
    if (e.type === "reversal" || e.reversedBy) continue;
    const f = COUNTER_OF[e.type];
    if (f) out[f] += e.amountMinor;
  }
  return out;
}

// مفتاح الفترة الحالية (UTC، كبقية حدود الفترات) والتنقل بالأشهر
const currentKey = (now = new Date()) => now.toISOString().slice(0, 7);
const addMonths = (key, n) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
// فترة تقبل أن تُسنَد إليها سلفة أو تُسوّى عليها (لم تُسدَّد بالكامل ولم تُغلق)
const OPEN_STATUSES = ["draft", "approved", "partially_paid"];
// أقرب فترة صالحة بدءاً من startKey (غير موجودة = تُنشأ، أو مفتوحة): خريطة {key: period}
function eligibleKey(startKey, periodsByKey, horizon = 24) {
  for (let i = 0; i < horizon; i++) {
    const k = addMonths(startKey, i);
    const p = periodsByKey[k];
    if (!p || OPEN_STATUSES.includes(p.status)) return k;
  }
  throw new Error("NO_ELIGIBLE_PERIOD");
}

/**
 * خطة التسوية التلقائية للسلف المجدولة على فترة (الأقدم أولاً): تُسوّى من الراتب بقدر ما يتسع له المتبقي منه فقط،
 * وما يزيد عن ذلك يُرحَّل (carry) إلى الفترة الصالحة التالية دون إنشاء سلفة ثانية ودون صرف جديد.
 * advances: سلف مصروفة (disbursed / partially_settled) مسنَدة للفترة، مرتبة بالأقدم أولاً.
 */
function projectSettlements(period, advances) {
  let room = Math.max(remainingPayable(period), 0);
  const items = [];
  for (const a of advances) {
    const out = advanceOutstanding(a);
    if (out <= 0) continue;
    const settleMinor = Math.min(out, room);
    room -= settleMinor;
    items.push({ advance: a, settleMinor, carryMinor: out - settleMinor });
  }
  return { items, totalSettleMinor: items.reduce((n, i) => n + i.settleMinor, 0), totalCarryMinor: items.reduce((n, i) => n + i.carryMinor, 0) };
}

module.exports = {
  isSalaryCategory, eligibilityReason, monthOf,
  currentKey, addMonths, OPEN_STATUSES, eligibleKey, projectSettlements,
  PERIOD_KEY, netEntitlement, remainingPayable, advanceOutstanding, derivedStatus, canTransition, periodBounds, indicator, countersFromLedger, COUNTER_OF,
  OPEN_FOR_SETTLEMENT, OPEN_FOR_PAYMENT, OPEN_FOR_REVERSAL,
};
