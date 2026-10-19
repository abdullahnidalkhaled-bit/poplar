const Return = require("../models/return.model");
const { sessionOpts } = require("../utils/unitOfWork");

const create = async (data, ctx) => (await Return.create([data], sessionOpts(ctx)))[0];
const deleteById = (id, ctx) => Return.deleteOne({ _id: id }, sessionOpts(ctx));
const setExchange = (id, invoice, ctx) => Return.updateOne({ _id: id }, { exchangeInvoice: invoice._id, exchangeInvoiceNumber: invoice.number }, sessionOpts(ctx));
const list = (filter, limit = 300) => Return.find(filter).sort({ createdAt: -1 }).limit(limit);

const itemGroup = (key) => [
  { $unwind: "$items" },
  {
    $group: {
      _id: key,
      pieces: { $sum: "$items.qty" },
      revenueUsd: { $sum: { $multiply: ["$items.unitPriceUsd", "$items.qty"] } },
      costUsd: { $sum: { $multiply: ["$items.costPrice", "$items.qty"] } },
    },
  },
];

// تجميعات المرتجعات للتقرير
const returnsSummary = async (range, day) => {
  const [row] = await Return.aggregate([
    { $match: { createdAt: range } },
    {
      $facet: {
        totals: [{ $group: { _id: null, count: { $sum: 1 }, pieces: { $sum: { $sum: "$items.qty" } }, refundUsd: { $sum: "$refundUsd" }, reversedProfitUsd: { $sum: "$reversedProfitUsd" }, fxDiffUsd: { $sum: "$fxDiffUsd" }, writeOffUsd: { $sum: "$writeOffUsd" } } }],
        cash: [{ $group: { _id: "$currency", total: { $sum: "$cashRefund" } } }],
        daily: [{ $group: { _id: day, revenueUsd: { $sum: "$refundUsd" }, profitUsd: { $sum: { $add: ["$reversedProfitUsd", "$fxDiffUsd", "$writeOffUsd"] } } } }],
        byBrand: itemGroup("$items.brand"),
        byOrigin: itemGroup("$items.origin"),
      },
    },
  ]);
  return row;
};

module.exports = { create, deleteById, setExchange, list, returnsSummary };
