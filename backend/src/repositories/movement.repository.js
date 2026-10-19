const StockMovement = require("../models/movement.model");
const { sessionOpts } = require("../utils/unitOfWork");

// تسجيل داخل نفس الوحدة الذرّية للعملية: لا حركة بلا عملية ولا عملية بلا حركة
const insertMany = (rows, ctx) => (rows.length ? StockMovement.insertMany(rows, sessionOpts(ctx)) : Promise.resolve([]));

const query = async (filter, { sort, skip, limit }) => {
  const [items, total] = await Promise.all([
    StockMovement.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    StockMovement.countDocuments(filter),
  ]);
  return { items, total };
};

// صافي المباع فعلياً لكل (رتل، مقاس): sale − cancel − return(سليم). المرتجع التالف بلا توزيع فلا يُطرح تلقائياً (مطابقة يدوية)
async function netSoldBySeries(seriesIds) {
  const mongoose = require("mongoose");
  const ids = seriesIds.map((i) => new mongoose.Types.ObjectId(String(i)));
  const rows = await StockMovement.aggregate([
    { $match: { type: { $in: ["sale", "cancel", "return"] }, "allocations.series": { $in: ids } } },
    { $unwind: "$allocations" },
    { $match: { "allocations.series": { $in: ids } } },
    { $group: { _id: { series: "$allocations.series", size: "$size", type: "$type" }, qty: { $sum: "$allocations.qty" } } },
  ]);
  const out = new Map(); // "seriesId|size" -> net
  for (const r of rows) {
    const k = `${r._id.series}|${r._id.size}`;
    out.set(k, (out.get(k) || 0) + (r._id.type === "sale" ? r.qty : -r.qty));
  }
  return out;
}

const recent = (limit) => StockMovement.find().sort({ createdAt: -1 }).limit(limit).lean();

const bySeries = (seriesId, limit = 100) => StockMovement.find({ "allocations.series": seriesId }).sort({ createdAt: -1 }).limit(limit).lean();

const damagedTotals = async (range) => {
  const [row] = await StockMovement.aggregate([
    { $match: { type: "damaged", createdAt: range } },
    { $group: { _id: null, pieces: { $sum: "$qty" }, costUsd: { $sum: "$costUsd" } } },
  ]);
  return row;
};

const deleteByIds = (ids) => StockMovement.deleteMany({ _id: { $in: ids } });

module.exports = { netSoldBySeries, insertMany, deleteByIds, query, recent, bySeries, damagedTotals };
