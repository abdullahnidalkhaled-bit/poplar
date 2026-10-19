const Invoice = require("../models/invoice.model");
const { sessionOpts } = require("../utils/unitOfWork");

const findById = (id, ctx) => Invoice.findById(id, null, sessionOpts(ctx));
const create = async (data, ctx) => (await Invoice.create([data], sessionOpts(ctx)))[0];
const deleteById = (id, ctx) => Invoice.deleteOne({ _id: id }, sessionOpts(ctx));
const list = (filter, limit = 300) => Invoice.find(filter).sort({ createdAt: -1 }).limit(limit);

// حجز كمية مرتجعة على بند الفاتورة بشكل ذرّي (يمنع الإرجاع المزدوج)
const reserveReturnedQty = async (invoiceId, itemIndex, qty, itemQty, ctx) => {
  const field = `items.${itemIndex}.returnedQty`;
  const r = await Invoice.updateOne(
    { _id: invoiceId, status: "completed", $or: [{ [field]: { $exists: false } }, { [field]: { $lte: itemQty - qty } }] },
    { $inc: { [field]: qty } },
    sessionOpts(ctx)
  );
  return r.modifiedCount === 1;
};
const releaseReturnedQty = (invoiceId, itemIndex, qty) => Invoice.updateOne({ _id: invoiceId }, { $inc: { [`items.${itemIndex}.returnedQty`]: -qty } });

const markCancelled = (id, ctx) => Invoice.updateOne({ _id: id, status: "completed" }, { status: "cancelled", cancelledAt: new Date() }, sessionOpts(ctx));
const unmarkCancelled = (id) => Invoice.updateOne({ _id: id }, { status: "completed", $unset: { cancelledAt: 1 } });

// ---------- تجميعات تقرير المبيعات ----------
const itemRevenue = { $multiply: ["$items.unitPriceUsd", "$items.qty"] };
const itemCost = { $multiply: ["$items.costPrice", "$items.qty"] };
const groupItems = (key) => [
  { $unwind: "$items" },
  { $group: { _id: key, pieces: { $sum: "$items.qty" }, revenueUsd: { $sum: itemRevenue }, costUsd: { $sum: itemCost } } },
  { $addFields: { profitUsd: { $subtract: ["$revenueUsd", "$costUsd"] } } },
];

// range: { $gte, $lt }، day: تعبير تجميع اليوم بمنطقة زمنية
const salesSummary = async (range, day) => {
  const [row] = await Invoice.aggregate([
    { $match: { status: "completed", createdAt: range } },
    {
      $facet: {
        totals: [{ $group: { _id: null, invoices: { $sum: 1 }, pieces: { $sum: "$itemsCount" }, revenueUsd: { $sum: "$totalUsd" }, costUsd: { $sum: "$costUsd" }, profitUsd: { $sum: "$profitUsd" } } }],
        collected: [{ $group: { _id: "$currency", total: { $sum: { $ifNull: ["$cashDue", "$totalPaid"] } }, invoices: { $sum: 1 } } }],
        daily: [{ $group: { _id: day, invoices: { $sum: 1 }, revenueUsd: { $sum: "$totalUsd" }, profitUsd: { $sum: "$profitUsd" } } }],
        byBrand: groupItems("$items.brand"),
        byOrigin: groupItems("$items.origin"),
        top: [...groupItems({ modelNumber: "$items.modelNumber", name: "$items.name", brand: "$items.brand" }), { $sort: { pieces: -1 } }, { $limit: 10 }],
        flags: [{ $unwind: "$items" }, { $group: { _id: "$items.flag", lines: { $sum: 1 }, pieces: { $sum: "$items.qty" } } }],
        belowCost: [
          { $unwind: "$items" }, { $match: { "items.flag": "below_cost" } }, { $sort: { createdAt: -1 } }, { $limit: 50 },
          { $project: { _id: 0, number: 1, createdAt: 1, currency: 1, item: "$items" } },
        ],
      },
    },
  ]);
  return row;
};

module.exports = { findById, create, deleteById, list, reserveReturnedQty, releaseReturnedQty, markCancelled, unmarkCancelled, salesSummary };
