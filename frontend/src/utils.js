const pad = (n) => String(n).padStart(2, "0");

export const num = (n, digits = 0) =>
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

// الإشارة قبل رمز العملة (-$1,042.00)؛ الصفر وما يُقرَّب إلى صفر بلا إشارة
export const usd = (n) => {
  const body = num(Math.abs(Number(n) || 0), 2);
  return Number(n) < 0 && body !== "0.00" ? `-$${body}` : `$${body}`;
};
export const syp = (n) => `${num(Math.round(n))} ل.س`;
export const money = (n, currency) => (currency === "SYP" ? syp(n) : usd(n));

export const ORIGIN_LABEL = { foreign: "أجنبي", local: "وطني" };
export const FLAG_LABEL = {
  below_cost: "أقل من سعر الجملة (خسارة)",
  below_sell_price: "أقل من سعر البيع المحدد",
  normal: "",
};

// نفس منطق الـ Backend (للعرض الفوري فقط، والحكم النهائي للخادم)
export function flagOf(priceUsd, cost, sell, currency, rate) {
  const eps = currency === "SYP" && rate > 0 ? 0.5 / rate + 1e-9 : 0.005;
  // الموظف لا يتلقى سعر الجملة: لا مقارنة معه (الخادم هو من يقرّر الحكم النهائي)
  if (cost != null && priceUsd < cost - eps) return "below_cost";
  if (priceUsd < sell - eps) return "below_sell_price";
  return "normal";
}

export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthStr = () => todayStr().slice(0, 7);

// حدود اليوم والشهر بتوقيت الجهاز المحلي
export function dayRange(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}
export function monthRange(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return { from: new Date(y, m - 1, 1).toISOString(), to: new Date(y, m, 1).toISOString() };
}

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
export const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

// وصف البند/المقاس: رقم الموديل · المقاس (وللبيانات القديمة: قَصّة · لون · مقاس)
export const itemLabel = (v) =>
  v.modelNumber ? [v.modelNumber, v.size].filter(Boolean).join(" · ") : [v.legacy?.style || v.style, v.legacy?.color || v.color, v.size].filter(Boolean).join(" · ");
export const variantLabel = itemLabel;

// صوت قصير يؤكد المسح دون النظر للشاشة (نغمة عالية = نجاح، منخفضة = خطأ)
let audio;
export function beep(kind = "ok") {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = kind === "ok" ? 1040 : 220;
    o.type = kind === "ok" ? "sine" : "square";
    g.gain.value = 0.06;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (kind === "ok" ? 0.08 : 0.25));
  } catch {
    /* الصوت اختياري */
  }
}

export const invNo = (n) => `#${String(n).padStart(5, "0")}`;

export const MOVEMENT_LABEL = {
  sale: "بيع",
  receive: "استلام",
  transfer: "نقل",
  return: "مرتجع",
  return_damaged: "مرتجع تالف",
  damaged: "تالف",
  adjust: "تعديل جرد",
  cancel: "إلغاء فاتورة",
  supplier_return: "إرجاع للتاجر",
};
export const PLACE = { shop: "المحل", warehouse: "المستودع" };

// تحويل مبلغ بين العملتين بسعر الصرف الحالي
export const convertAmount = (amount, from, to, rate) => {
  if (from === to) return amount;
  return from === "SYP" ? amount / rate : amount * rate;
};

export const AVAILABILITY_LABEL = {
  both: "في المحل والمستودع",
  store_only: "في المحل فقط",
  warehouse_only: "في المستودع فقط",
  out_of_stock: "نفد من المخزون",
};
export const FACTORY_WARNING = "هذا المقاس نفد من المخزون. تواصل مع المصنع لطلب إعادة التوريد.";

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);
export const dayStartIso = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd).toISOString(); };
export const dayEndIso = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd + 1).toISOString(); };

// ترتيب منطقي للمقاسات (نفس منطق الخادم): XS S M L XL ... ثم الأرقام
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL", "5XL"];
const sizeRank = (s) => {
  const i = SIZE_ORDER.indexOf(s);
  if (i >= 0) return [0, i];
  const n = parseFloat(s);
  return Number.isNaN(n) ? [2, 0] : [1, n];
};
export const compareSizes = (a, b) => {
  const [ga, va] = sizeRank(a);
  const [gb, vb] = sizeRank(b);
  return ga - gb || va - vb || a.localeCompare(b);
};

export const SERIES_KIND_LABEL = { received: "مستلم", derived: "منقول جزئياً", balance: "رصيد" };

// حسابات التجار
export const ACCOUNT_STATUS = { settled: "مسدد بالكامل", due: "عليه مستحقات", advance: "رصيد سلفة", mixed: "مستحقات وسلف معاً" };
export const ENTRY_TYPE = {
  purchase: "فاتورة شراء", adjustment: "تسوية مدينة", payment: "دفعة", advance: "سلفة", credit: "إشعار دائن", return_credit: "ائتمان إرجاع", reversal: "قيد عكسي",
};
export const INVOICE_KIND = { purchase: "شراء", consignment_settlement: "تسوية أمانة" };
export const PAY_STATUS = { paid: "مسددة", partial: "مخصَّص جزئياً", unpaid: "غير مسددة" };
export const CUR = { USD: "$", SYP: "ل.س" };
// عملتان مستقلتان: كل مبلغ بعملته. لا تحويل ولا جمع بين الدولار والليرة في أي مكان
export const CUR_NAME = { USD: "الدولار الأمريكي", SYP: "الليرة السورية" };
export const CASH_TYPE = {
  sale_receipt: "قبض فاتورة بيع", sale_cancellation: "عكس قبض (إلغاء فاتورة)", customer_refund: "رد للزبون", supplier_payment: "دفعة لمورّد", supplier_advance: "سلفة لمورّد",
  supplier_reversal: "عكس دفعة مورّد", expense: "مصروف", expense_reversal: "عكس مصروف", deposit: "إيداع يدوي", withdrawal: "سحب يدوي", reversal: "عكس حركة يدوية",
  employee_advance: "سلفة موظف", salary_payment: "راتب موظف", payroll_reversal: "عكس راتب/سلفة موظف",
};
// صافي حساب مورّد بعملته: موجب = عليكم، سالب = لكم (سلفة)
export const netText = (v, cur) => (Math.abs(v) < 0.005 ? "صفر" : v > 0 ? `عليكم ${money(v, cur)}` : `لكم ${money(-v, cur)}`);
