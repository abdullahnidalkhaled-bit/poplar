const Invoice = require("../models/invoice.model");
const Return = require("../models/return.model");
const StockMovement = require("../models/movement.model");

// وحدة صغرى صحيحة لكل وثيقة قبل الجمع (سنت للدولار، ليرة للسوري): الجمع على أعداد صحيحة
const minor = (field) => ({ $cond: [{ $eq: ["$currency", "SYP"] }, { $round: [field, 0] }, { $round: [{ $multiply: [field, 100] }, 0] }] });
const usdCents = (field) => ({ $round: [{ $multiply: [field, 100] }, 0] });

/**
 * مبيعات الفواتير المكتملة في الفترة لكل عملة فاتورة (لا تحويل): الإيراد = إجمالي الفاتورة بعملتها،
 * التكلفة = تكلفة المخزون الأصلية (بالدولار) وتُعتمد فقط لفواتير الدولار. لفواتير الليرة تُحسب تقديراً منفصلاً بسعر صرف الفاتورة نفسها.
 */
async function salesByCurrency(range) {
  return Invoice.aggregate([
    { $match: { status: "completed", createdAt: range } },
    {
      $group: {
        _id: "$currency",
        invoices: { $sum: 1 },
        pieces: { $sum: "$itemsCount" },
        revenueMinor: { $sum: minor("$totalPaid") },
        costUsdCents: { $sum: usdCents("$costUsd") },
        // تقدير ليرة (مستقل): تكلفة الدولار × سعر صرف الفاتورة نفسها (ليرة صحيحة بعد التقريب)
        estCostSyp: { $sum: { $cond: [{ $eq: ["$currency", "SYP"] }, { $multiply: ["$costUsd", "$rate"] }, 0] } },
      },
    },
  ]);
}

// مرتجعات الفترة لكل عملة فاتورة: المبلغ المردود، وتكلفة القطع السليمة العائدة للمخزون (تُعكس من التكلفة)
async function returnsByCurrency(range) {
  return Return.aggregate([
    { $match: { createdAt: range } },
    { $lookup: { from: "invoices", localField: "invoice", foreignField: "_id", as: "inv" } },
    { $addFields: { invRate: { $ifNull: [{ $arrayElemAt: ["$inv.rate", 0] }, 0] }, goodCostUsd: { $sum: { $map: { input: { $filter: { input: "$items", as: "i", cond: { $eq: ["$$i.condition", "good"] } } }, as: "g", in: { $multiply: ["$$g.costPrice", "$$g.qty"] } } } } } },
    {
      $group: {
        _id: "$currency",
        count: { $sum: 1 },
        refundMinor: { $sum: minor("$refundAmount") },
        goodCostUsdCents: { $sum: usdCents("$goodCostUsd") },
        estGoodCostSyp: { $sum: { $cond: [{ $eq: ["$currency", "SYP"] }, { $multiply: ["$goodCostUsd", "$invRate"] }, 0] } },
      },
    },
  ]);
}

// إتلاف مباشر للمخزون (تكلفة بالدولار فقط: لا عملة بيع له)
async function damagedCostUsdCents(range) {
  const [row] = await StockMovement.aggregate([
    { $match: { type: "damaged", createdAt: range } },
    { $group: { _id: null, cents: { $sum: usdCents("$costUsd") }, pieces: { $sum: "$qty" } } },
  ]);
  return row || { cents: 0, pieces: 0 };
}

// إيراد يومي لكل عملة
async function dailyRevenue(range, tz) {
  const day = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } };
  return Invoice.aggregate([
    { $match: { status: "completed", createdAt: range } },
    { $group: { _id: { day, currency: "$currency" }, revenueMinor: { $sum: minor("$totalPaid") } } },
  ]);
}

// فواتير/مرتجعات لم تُسجَّل لها حركات نقد (بيانات تاريخية): للمطابقة اليدوية فقط، بلا ترحيل تلقائي
async function legacyUncashed(CashMovement) {
  const ids = (await CashMovement.distinct("source.id", { "source.kind": "invoice" })).map(String);
  const rows = await Invoice.aggregate([
    { $match: { status: "completed" } },
    { $group: { _id: "$currency", invoices: { $sum: 1 }, ids: { $push: "$_id" }, cashMinor: { $sum: minor({ $ifNull: ["$cashDue", "$totalPaid"] }) } } },
  ]);
  return rows.map((r) => ({ currency: r._id, invoices: r.invoices, uncashed: r.ids.filter((i) => !ids.includes(String(i))).length, cashMinor: r.cashMinor }));
}

module.exports = { salesByCurrency, returnsByCurrency, damagedCostUsdCents, dailyRevenue, legacyUncashed };
