const cashRepo = require("../repositories/cash.repository");
const financeRepo = require("../repositories/finance.repository");
const CashMovement = require("../models/cashMovement.model");
const supplierService = require("./supplier.service");
const { fromMinorC } = require("../utils/money");
const { badRequest } = require("../utils/errors");

/**
 * لوحة المالية: قسمان مستقلان تماماً (ليرة سورية / دولار). القواعد:
 *  - لا يوجد أي مجموع مشترك ولا تحويل بين العملتين ولا استعمال لمعادلات الدولار المحفوظة في دفتر الموردين.
 *  - النقد من دفتر الصندوقين وحده (cash_movements). الإيراد والتكلفة والربح مفاهيم محاسبية مستقلة عن النقد.
 *  - ما لا يمكن حسابه بدقة يظهر null مع سبب (لا قيمة مخترعة).
 *
 * التعريفات (لكل عملة، خلال الفترة):
 *   إيراد المبيعات      = Σ إجمالي الفواتير المكتملة بتلك العملة (يُستثنى الملغى)
 *   المرتجعات          = Σ المبالغ المردودة/المسجَّلة كمرتجع على فواتير تلك العملة
 *   صافي الإيراد        = إيراد المبيعات − المرتجعات
 *   تكلفة البضاعة (COGS)= Σ تكلفة الفواتير − تكلفة القطع السليمة المرتجعة   (الدولار فقط: تكلفة المخزون بالدولار)
 *   مجمل الربح          = صافي الإيراد − COGS
 *   المصروفات التشغيلية = Σ مصروفات سارية بتلك العملة (غير المعكوسة)
 *   خسائر إتلاف المخزون = Σ تكلفة حركات «تالف» (تكلفة بالدولار فقط)
 *   صافي الربح          = مجمل الربح − المصروفات − خسائر الإتلاف
 * الليرة: تكلفة المخزون بالدولار ولا يوجد أساس تكلفة بالليرة؛ لذا COGS/مجمل/صافي الربح بالليرة "غير متاحة"،
 * ويُعرض تقدير منفصل مُعلَّم بسعر صرف كل فاتورة نفسها فقط (لا يدخل في أي مجموع).
 */
const CURS = ["USD", "SYP"];
const mj = (c, v) => fromMinorC(c, v);
const pick = (rows, c) => rows.find((r) => r._id === c) || {};

async function periodMetrics(range, tz) {
  const [sales, rets, expenses, cashTotals, byType, damaged] = await Promise.all([
    financeRepo.salesByCurrency(range),
    financeRepo.returnsByCurrency(range),
    cashRepo.expenseTotals(range),
    cashRepo.totals({ date: range }),
    cashRepo.totalsByType({ date: range }),
    financeRepo.damagedCostUsdCents(range),
  ]);
  void tz;
  const out = {};
  for (const c of CURS) {
    const s = pick(sales, c), r = pick(rets, c);
    const revenue = s.revenueMinor || 0, refunds = r.refundMinor || 0, net = revenue - refunds;
    const exps = expenses.filter((e) => e._id.currency === c);
    const expTotal = exps.reduce((n, e) => n + e.minor, 0);
    const t = byType[c] || {};
    const supplierPaid = (t.supplier_payment?.out || 0) + (t.supplier_advance?.out || 0) - (t.supplier_reversal?.in || 0);
    const block = {
      currency: c,
      cash: { in: cashTotals[c].in, out: cashTotals[c].out, net: cashTotals[c].in - cashTotals[c].out },
      revenue, refunds, netRevenue: net, invoices: s.invoices || 0, pieces: s.pieces || 0, returnsCount: r.count || 0,
      expenses: expTotal, expensesByCategory: exps.map((e) => ({ category: e._id.category, amount: e.minor })).sort((a, b) => b.amount - a.amount),
      supplierPayments: supplierPaid,
      customerRefundsCash: t.customer_refund?.out || 0,
    };
    if (c === "USD") {
      const cogs = (s.costUsdCents || 0) - (r.goodCostUsdCents || 0);
      block.cogs = cogs; block.grossProfit = net - cogs; block.writeOffs = damaged.cents; block.writeOffPieces = damaged.pieces;
      block.netProfit = net - cogs - expTotal - damaged.cents;
    } else {
      block.cogs = null; block.grossProfit = null; block.netProfit = null; block.writeOffs = null;
      const estCogs = Math.round((s.estCostSyp || 0) - (r.estGoodCostSyp || 0));
      block.estimate = { cogs: estCogs, grossProfit: net - estCogs, netProfit: net - estCogs - expTotal };
    }
    out[c] = block;
  }
  return out;
}

// تحويل أرقام القسم إلى وحدات كبرى مع إبقاء null كما هي
function present(c, b) {
  const m = (v) => (v == null ? null : mj(c, v));
  return {
    currency: c,
    cash: { in: m(b.cash.in), out: m(b.cash.out), net: m(b.cash.net) },
    revenue: m(b.revenue), refunds: m(b.refunds), netRevenue: m(b.netRevenue), invoices: b.invoices, pieces: b.pieces, returnsCount: b.returnsCount,
    cogs: m(b.cogs), grossProfit: m(b.grossProfit), expenses: m(b.expenses), writeOffs: m(b.writeOffs), writeOffPieces: b.writeOffPieces ?? null, netProfit: m(b.netProfit),
    expensesByCategory: b.expensesByCategory.map((e) => ({ category: e.category, amount: m(e.amount) })),
    supplierPayments: m(b.supplierPayments), customerRefundsCash: m(b.customerRefundsCash),
    estimate: b.estimate ? { cogs: m(b.estimate.cogs), grossProfit: m(b.estimate.grossProfit), netProfit: m(b.estimate.netProfit) } : null,
  };
}

async function dashboard({ from, to, tz }) {
  if (!from || !to) throw badRequest("حدّد الفترة (from و to).", "RANGE_REQUIRED");
  const start = new Date(from), end = new Date(to);
  if (!(end > start)) throw badRequest("نهاية الفترة قبل بدايتها.", "INVALID_RANGE");
  const zone = /^[A-Za-z0-9_+\-/]+$/.test(tz || "") ? tz : "UTC";
  const range = { $gte: start, $lt: end };
  const len = end - start;
  const prevRange = { $gte: new Date(start - len), $lt: start };

  const [cur, prev, balances, suppliers, cashDaily, revDaily, legacy] = await Promise.all([
    periodMetrics(range, zone),
    periodMetrics(prevRange, zone),
    cashRepo.totals({}),
    supplierService.summary(),
    cashRepo.daily({ date: range }, zone),
    financeRepo.dailyRevenue(range, zone),
    financeRepo.legacyUncashed(CashMovement),
  ]);

  const sections = {};
  for (const c of CURS) {
    const days = new Map();
    for (const r of cashDaily.filter((x) => x._id.currency === c)) { const d = days.get(r._id.day) || { day: r._id.day, in: 0, out: 0, revenue: 0 }; d[r._id.direction] += r.minor; days.set(r._id.day, d); }
    for (const r of revDaily.filter((x) => x._id.currency === c)) { const d = days.get(r._id.day) || { day: r._id.day, in: 0, out: 0, revenue: 0 }; d.revenue += r.revenueMinor; days.set(r._id.day, d); }
    const sup = suppliers.totals[c];
    const lg = legacy.find((l) => l.currency === c);
    sections[c] = {
      ...present(c, cur[c]),
      balance: mj(c, balances[c].in - balances[c].out),
      balanceAllTime: { in: mj(c, balances[c].in), out: mj(c, balances[c].out), movements: balances[c].count },
      previous: { netRevenue: mj(c, prev[c].netRevenue), expenses: mj(c, prev[c].expenses), cashNet: mj(c, prev[c].cash.net), netProfit: prev[c].netProfit == null ? null : mj(c, prev[c].netProfit) },
      daily: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({ day: d.day, in: mj(c, d.in), out: mj(c, d.out), revenue: mj(c, d.revenue) })),
      supplierPayable: sup.grossPayable, supplierAdvances: sup.advance,
      customerReceivables: { supported: false, reason: "المبيعات نقدية: لا ذمم للزبائن في النظام." },
      legacy: lg ? { invoicesWithoutCash: lg.uncashed, completedInvoices: lg.invoices } : { invoicesWithoutCash: 0, completedInvoices: 0 },
      unavailable: c === "SYP" ? "تكلفة المخزون مسجّلة بالدولار؛ لا أساس تكلفة بالليرة، فمجمل وصافي الربح بالليرة غير متاحين (انظر التقدير المنفصل)." : null,
    };
  }
  return { period: { from: start, to: end, previousFrom: prevRange.$gte, previousTo: prevRange.$lt }, USD: sections.USD, SYP: sections.SYP };
}

module.exports = { dashboard };
