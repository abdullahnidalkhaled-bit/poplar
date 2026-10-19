// منطق حسابات التجار الخالص (بلا قاعدة بيانات). كل حساب بالعملة الأصلية للقيد وبوحدتها الصغرى الصحيحة
// (سنت للدولار، ليرة كاملة للسوري). لا تحويل ولا جمع بين العملتين في أي مكان: لكل عملة مراكزها المستقلة.
//
// اصطلاح الإشارة (signedMinor): موجب يزيد ما على المحل للتاجر (فاتورة، تسوية مدينة)، سالب يخفضه (دفعة، سلفة، إشعار دائن، ائتمان إرجاع).
// المراكز المالية لكل عملة c (لا يُخفيها الصافي):
//   grossPayable[c] = فواتير حيّة + تسويات مدينة − ما خُصِّص على فواتير هذه العملة
//   advance[c]      = أرصدة دائنة حيّة − ما استُهلك منها في تخصيصات (بعملة الرصيد)
//   net[c]          = grossPayable[c] − advance[c]
// التخصيص سجل صريح للإلحاق فقط. الأصل أن يتم بين عملة واحدة؛ والتخصيص عبر العملتين لا يتم إلا بتأكيد صريح ومبلغين وسعر صرف مُدخَل.
const { fromMinorC } = require("./money");

const CURS = ["USD", "SYP"];
const DEBIT_TYPES = new Set(["purchase", "adjustment"]);
const CREDIT_TYPES = new Set(["payment", "advance", "credit", "return_credit"]);
const CASH_OUT_TYPES = new Set(["payment", "advance"]); // وحدهما تُخرجان نقداً من الصندوق

const isLive = (e) => e.type !== "reversal" && !e.reversedBy;                        // قيد غير معكوس
const isLiveAlloc = (a) => a.kind === "apply" && !a.releasedBy && !a.needsReview;    // تخصيص ساري

// المبلغ بالوحدة الصغرى بعملة القيد (يقرأ الحقل الجديد، وللسجلات القديمة يشتقه من المبلغ الأصلي بعملته)
const amountMinorOf = (e) => e.amountMinor ?? (e.currency === "SYP" ? Math.round(e.amount || 0) : Math.round((e.amount || 0) * 100));
const typeSign = (type) => (DEBIT_TYPES.has(type) ? 1 : CREDIT_TYPES.has(type) ? -1 : 0);
const signedMinorOf = (e) => {
  if (e.signedMinor != null) return e.signedMinor;
  const legacy = e.deltaMinor ?? e.delta;
  const sign = legacy != null ? Math.sign(legacy) : typeSign(e.type);
  return sign * amountMinorOf(e);
};
const signedMinor = (type, minor) => {
  const s = typeSign(type);
  if (!s) throw new Error(`نوع قيد غير قابل للحساب المباشر: ${type}`);
  return s * minor;
};
const invoiceMinorOf = (inv) => inv.amountMinor ?? (inv.currency === "SYP" ? Math.round(inv.amount || 0) : Math.round((inv.amount || 0) * 100));

const major = (cur, minor) => fromMinorC(cur, minor);

function statusOf(grossAny, advanceAny) {
  if (grossAny && advanceAny) return "mixed";
  if (grossAny) return "due";
  if (advanceAny) return "advance";
  return "settled";
}

// قيم التخصيص بعملتي الفاتورة والرصيد (للسجلات القديمة بلا الحقول الجديدة تُستنتج العملة من الفاتورة/القيد المرتبطين)
function normAlloc(a, invById, entById) {
  const inv = invById?.get(String(a.invoice)), ent = entById?.get(String(a.entry));
  const currency = a.currency || inv?.currency;
  const creditCurrency = a.creditCurrency || ent?.currency || currency;
  return { ...a, currency, creditCurrency, creditMinor: a.creditMinor ?? a.amountMinor };
}

function allocationTotals(allocations, invoices, entries) {
  const invById = invoices && new Map(invoices.map((i) => [String(i._id), i]));
  const entById = entries && new Map(entries.map((e) => [String(e._id), e]));
  const byInvoice = new Map(), byEntry = new Map();
  const perInv = { USD: 0, SYP: 0 }, perCredit = { USD: 0, SYP: 0 };
  for (const raw of allocations.filter(isLiveAlloc)) {
    const a = normAlloc(raw, invById, entById);
    byInvoice.set(String(a.invoice), (byInvoice.get(String(a.invoice)) || 0) + a.amountMinor);
    byEntry.set(String(a.entry), (byEntry.get(String(a.entry)) || 0) + a.creditMinor);
    if (a.currency) perInv[a.currency] += a.amountMinor;
    if (a.creditCurrency) perCredit[a.creditCurrency] += a.creditMinor;
  }
  return { byInvoice, byEntry, perInv, perCredit };
}

// الملخص المالي من القيود والتخصيصات (مصدر الحقيقة). كل عملة منفصلة تماماً
function summarize(entries, allocations = [], invoices = []) {
  const per = Object.fromEntries(CURS.map((c) => [c, { invoicedMinor: 0, adjustmentsMinor: 0, creditsMinor: 0 }]));
  for (const e of entries) {
    if (!isLive(e)) continue;
    const p = per[e.currency];
    if (!p) continue;
    const m = amountMinorOf(e);
    if (e.type === "purchase") p.invoicedMinor += m;
    else if (e.type === "adjustment") p.adjustmentsMinor += m;
    else if (CREDIT_TYPES.has(e.type)) p.creditsMinor += m;
  }
  const t = allocationTotals(allocations, invoices, entries);
  const out = {};
  for (const c of CURS) {
    const p = per[c];
    const gross = p.invoicedMinor + p.adjustmentsMinor - t.perInv[c];
    const advance = p.creditsMinor - t.perCredit[c];
    out[c] = { ...p, allocatedInvoiceMinor: t.perInv[c], allocatedCreditMinor: t.perCredit[c], grossMinor: gross, advanceMinor: advance, netMinor: gross - advance };
  }
  const hasGross = CURS.some((c) => out[c].grossMinor > 0), hasAdvance = CURS.some((c) => out[c].advanceMinor > 0);
  return { ...out, status: statusOf(hasGross, hasAdvance), hasGross, hasAdvance };
}

// حالة كل فاتورة بعملتها: مخصَّص/متبقٍ
function invoiceStates(invoices, allocations, entries) {
  const { byInvoice } = allocationTotals(allocations, invoices, entries);
  const out = new Map();
  for (const inv of invoices) {
    const total = invoiceMinorOf(inv);
    const alloc = inv.status === "posted" ? byInvoice.get(String(inv._id)) || 0 : 0;
    const left = inv.status === "posted" ? total - alloc : 0;
    out.set(String(inv._id), { currency: inv.currency, allocatedMinor: alloc, outstandingMinor: left, payStatus: left <= 0 ? "paid" : alloc > 0 ? "partial" : "unpaid" });
  }
  return out;
}

// الأرصدة الدائنة المتاحة لكل قيد دائن حيّ (بعملة القيد)
function creditStates(entries, allocations, invoices) {
  const { byEntry } = allocationTotals(allocations, invoices, entries);
  return entries.filter((e) => isLive(e) && CREDIT_TYPES.has(e.type)).map((e) => {
    const alloc = byEntry.get(String(e._id)) || 0;
    return { entry: e, currency: e.currency, totalMinor: amountMinorOf(e), allocatedMinor: alloc, availableMinor: amountMinorOf(e) - alloc };
  });
}

// الرصيد الجاري بعد كل قيد بعملته هو (حسابان مستقلان) ، مرتب تصاعدياً
function withRunningBalance(entriesAsc) {
  const running = { USD: 0, SYP: 0 };
  return entriesAsc.map((e) => {
    running[e.currency] += signedMinorOf(e);
    return { ...e, balanceMinor: running[e.currency], balance: major(e.currency, running[e.currency]) };
  });
}

/**
 * التطبيق التلقائي (بطلب صريح فقط): الأرصدة الدائنة المتاحة من الأقدم فالأحدث على الفواتير المفتوحة من الأقدم فالأحدث،
 * ضمن العملة نفسها فقط (لا تخصيص تلقائي عبر العملتين أبداً). تعيد خطة ولا تكتب شيئاً.
 */
function planAutoAllocation(invoices, entries, allocations, onlyEntryId) {
  const inv = invoiceStates(invoices, allocations, entries);
  const open = invoices
    .filter((i) => i.status === "posted" && (inv.get(String(i._id))?.outstandingMinor || 0) > 0)
    .sort((a, b) => new Date(a.invoiceDate) - new Date(b.invoiceDate) || String(a._id).localeCompare(String(b._id)));
  const left = new Map(open.map((i) => [String(i._id), inv.get(String(i._id)).outstandingMinor]));
  const credits = creditStates(entries, allocations, invoices)
    .filter((c) => c.availableMinor > 0 && (!onlyEntryId || String(c.entry._id) === String(onlyEntryId)))
    .sort((a, b) => new Date(a.entry.date) - new Date(b.entry.date) || String(a.entry._id).localeCompare(String(b.entry._id)));
  const plan = [];
  for (const c of credits) {
    let avail = c.availableMinor;
    for (const i of open) {
      if (avail <= 0) break;
      if (i.currency !== c.currency) continue;
      const need = left.get(String(i._id));
      if (!need) continue;
      const take = Math.min(avail, need);
      plan.push({ entry: c.entry, invoice: i, amountMinor: take });
      left.set(String(i._id), need - take);
      avail -= take;
    }
  }
  return plan;
}

module.exports = {
  CURS, DEBIT_TYPES, CREDIT_TYPES, CASH_OUT_TYPES, amountMinorOf, signedMinorOf, signedMinor, invoiceMinorOf, isLive, isLiveAlloc, major, statusOf,
  allocationTotals, summarize, invoiceStates, creditStates, withRunningBalance, planAutoAllocation,
};
