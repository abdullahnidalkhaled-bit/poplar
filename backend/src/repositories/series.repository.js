const mongoose = require("mongoose");
const Series = require("../models/series.model");
const { sessionOpts } = require("../utils/unitOfWork");

// ---------- قراءة ----------
const findById = (id, ctx) => Series.findById(id, null, sessionOpts(ctx));
const findBySeriesNo = (no, ctx) => Series.findOne({ seriesNo: no }, null, sessionOpts(ctx));

// الأرتال التي فيها المقاس بكمية > 0 في موقع معيّن، الأقدم أولاً (FIFO)
const findFifo = (modelId, location, size, ctx) =>
  Series.find(
    { model: modelId, location, sizes: { $elemMatch: { size, qty: { $gt: 0 } } } },
    null,
    sessionOpts(ctx)
  ).sort({ receivedAt: 1, _id: 1 });

const findDerived = (originId, location, ctx) =>
  Series.findOne({ kind: "derived", originSeries: originId, location }, null, sessionOpts(ctx));
const findBalance = (modelId, location, ctx) =>
  Series.findOne({ kind: "balance", model: modelId, location }, null, sessionOpts(ctx));

const create = async (data, ctx) => {
  const [doc] = await Series.create([data], sessionOpts(ctx));
  return doc;
};
const deleteById = (id, ctx) => Series.deleteOne({ _id: id }, sessionOpts(ctx));

// ---------- كتابة ذرّية ----------
// إنقاص مشروط: لا يتغير شيء إن لم تكفِ الكمية. ثم يُعلَّم الرتل "منتهي" إن فرغ (لا يُحذف أبداً)
async function decrement(seriesId, size, n, ctx) {
  const updated = await Series.findOneAndUpdate(
    { _id: seriesId, sizes: { $elemMatch: { size, qty: { $gte: n } } } },
    { $inc: { "sizes.$[s].qty": -n, rev: 1 } },
    { returnDocument: "after", arrayFilters: [{ "s.size": size }], ...sessionOpts(ctx) }
  );
  if (updated && !updated.sizes.some((s) => s.qty > 0)) {
    await Series.updateOne(
      { _id: seriesId, sizes: { $not: { $elemMatch: { qty: { $gt: 0 } } } } },
      { $set: { status: "depleted" } },
      sessionOpts(ctx)
    );
  }
  return updated;
}

// زيادة (إعادة/استلام داخل رتل موجود). يضيف المقاس إن لم يكن موجوداً ويعيد تفعيل الرتل المنتهي
async function increment(seriesId, size, n, ctx) {
  await Series.updateOne(
    { _id: seriesId, "sizes.size": { $ne: size } },
    { $push: { sizes: { size, initialQty: 0, qty: 0 } } },
    sessionOpts(ctx)
  );
  return Series.findOneAndUpdate(
    { _id: seriesId },
    { $inc: { "sizes.$[s].qty": n, rev: 1 }, $set: { status: "active" } },
    { returnDocument: "after", arrayFilters: [{ "s.size": size }], ...sessionOpts(ctx) }
  );
}

// ---------- التجميع الوحيد لكميات المخزون ----------
/**
 * التجميع الوحيد لكميات المخزون: مجموع qty لكل (موديل، مقاس، موقع) عبر كل الأرتال.
 * modelIds = null يعني كل الموديلات. يعيد Map(modelId -> Map(size -> { shop, warehouse })).
 */
async function sumBySize(modelIds, ctx) {
  const match = modelIds ? { model: { $in: modelIds } } : {};
  const rows = await Series.aggregate(
    [
      { $match: match },
      { $unwind: "$sizes" },
      { $group: { _id: { model: "$model", size: "$sizes.size", location: "$location" }, qty: { $sum: "$sizes.qty" } } },
    ],
    sessionOpts(ctx)
  );
  const out = new Map();
  for (const r of rows) {
    const mid = String(r._id.model);
    if (!out.has(mid)) out.set(mid, new Map());
    const sizes = out.get(mid);
    if (!sizes.has(r._id.size)) sizes.set(r._id.size, { shop: 0, warehouse: 0 });
    sizes.get(r._id.size)[r._id.location] += r.qty;
  }
  return out;
}

const findManyByIds = (ids) => Series.find({ _id: { $in: ids } }).sort({ seriesNo: 1 });
const findChildren = (originId) => Series.find({ originSeries: originId }).select("seriesNo location").lean();

// ---------- سجل الأرتال (ترقيم وفلترة في القاعدة) ----------
const totalExpr = { $reduce: { input: "$sizes", initialValue: 0, in: { $add: ["$$value", "$$this.qty"] } } };

async function list(filter, { sort, skip, limit }) {
  const [rows, count] = await Promise.all([
    Series.aggregate([
      { $match: filter },
      { $addFields: { totalPieces: totalExpr } },
      { $sort: sort },
      { $skip: skip },
      { $limit: limit },
    ]),
    Series.countDocuments(filter),
  ]);
  return { items: rows, total: count };
}


// ---------- بضاعة الأمانة (ملكية تاجر): كلها تُحسب من أرتال الأرتال نفسها، لا مجاميع مخزنة ----------
const findBySeriesNos = (nos) => Series.find({ seriesNo: { $in: nos } }).lean();

// سعر القطعة المتفق عليه بعملته الأصلية (لا تحويل بين العملتين). غائب = لا اتفاق مسجّل: لا يُخمَّن من سعر الجملة الحالي
const withCost = [
  {
    $addFields: {
      remaining: totalExpr,
      agreedAmount: { $cond: [{ $gt: [{ $ifNull: ["$consignment.price.amount", 0] }, 0] }, "$consignment.price.amount", null] },
      agreedCurrency: { $cond: [{ $gt: [{ $ifNull: ["$consignment.price.amount", 0] }, 0] }, "$consignment.price.currency", null] },
    },
  },
];

// أرتال أمانة تاجر معيّن (match إضافي اختياري) مع التكلفة والكمية المتبقية
const consignmentSeries = (supplierId, extra = {}) =>
  Series.aggregate([
    { $match: { supplier: new mongoose.Types.ObjectId(String(supplierId)), ownership: "consignment", ...extra } },
    ...withCost,
    { $sort: { receivedAt: 1, _id: 1 } },
  ]);

// قطع وقيمة (بسعر الجملة الحالي للموديل) بضاعة الأمانة المتبقية، لكل تاجر
async function consignmentTotals(supplierIds) {
  const match = { ownership: "consignment", supplier: supplierIds ? { $in: supplierIds.map((i) => new mongoose.Types.ObjectId(String(i))) } : { $exists: true } };
  const val = (cur) => ({ $sum: { $cond: [{ $eq: ["$agreedCurrency", cur] }, { $multiply: ["$remaining", "$agreedAmount"] }, 0] } });
  const rows = await Series.aggregate([
    { $match: match },
    ...withCost,
    { $group: { _id: "$supplier", pieces: { $sum: "$remaining" }, unpricedPieces: { $sum: { $cond: [{ $eq: ["$agreedAmount", null] }, "$remaining", 0] } }, valueUsd: val("USD"), valueSyp: val("SYP") } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { pieces: r.pieces, unpricedPieces: r.unpricedPieces, valueUsd: Math.round(r.valueUsd * 100) / 100, valueSyp: Math.round(r.valueSyp) }]));
}

// تسوية شرطية ذرّية: تزيد settledQty فقط إن بقي منه ما يكفي (maxBefore = المباع الصافي − الكمية). لا تسوية مزدوجة حتى مع طلبات متزامنة
const settleQty = (seriesId, size, qty, maxBefore, ctx) =>
  Series.findOneAndUpdate(
    { _id: seriesId, sizes: { $elemMatch: { size, $or: [{ settledQty: { $lte: maxBefore } }, { settledQty: { $exists: false } }] } } },
    { $inc: { "sizes.$[s].settledQty": qty } },
    { returnDocument: "after", arrayFilters: [{ "s.size": size }], ...sessionOpts(ctx) }
  );
const unsettleQty = (seriesId, size, qty, ctx) =>
  Series.findOneAndUpdate(
    { _id: seriesId, sizes: { $elemMatch: { size, settledQty: { $gte: qty } } } },
    { $inc: { "sizes.$[s].settledQty": -qty } },
    { returnDocument: "after", arrayFilters: [{ "s.size": size }], ...sessionOpts(ctx) }
  );

// تسجيل/تعديل سعر الاتفاق مع سجل للإلحاق فقط. expectPrice=false => يشترط عدم وجود سعر (تسجيل أول)، true => يشترط وجوده (تعديل)
const setConsignmentPrice = (seriesId, supplierId, { price, entry, expectPrice }, ctx) =>
  Series.findOneAndUpdate(
    { _id: seriesId, supplier: supplierId, ownership: "consignment", "consignment.price.amount": expectPrice ? { $gt: 0 } : { $exists: false } },
    { $set: { "consignment.price": price }, $push: { "consignment.history": entry } },
    { returnDocument: "after", ...sessionOpts(ctx) }
  );

const revertConsignmentPrice = (seriesId, previous) =>
  Series.updateOne(
    { _id: seriesId },
    previous ? { $set: { "consignment.price": previous }, $pop: { "consignment.history": 1 } } : { $unset: { "consignment.price": 1 }, $pop: { "consignment.history": 1 } }
  );

module.exports = { revertConsignmentPrice, settleQty, unsettleQty, setConsignmentPrice, findBySeriesNos, consignmentSeries, consignmentTotals, sumBySize, findManyByIds, findChildren, findById, findBySeriesNo, findFifo, findDerived, findBalance, create, deleteById, decrement, increment, list };
