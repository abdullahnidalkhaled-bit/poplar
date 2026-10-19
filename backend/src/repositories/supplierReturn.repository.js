const mongoose = require("mongoose");
const SupplierReturn = require("../models/supplierReturn.model");

const create = async (data) => (await SupplierReturn.create(data)).toObject();
const findByKey = (idempotencyKey) => SupplierReturn.findOne({ idempotencyKey }).lean();
const markApplied = (id, entry) => SupplierReturn.updateOne({ _id: id }, { $set: { status: "applied", ...(entry ? { entry } : {}) } });
const deleteById = (id) => SupplierReturn.deleteOne({ _id: id });
const listBySupplier = (supplier, limit = 100) =>
  SupplierReturn.find({ supplier, status: "applied" }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();

// ما أُرجع فعلاً لكل موديل (للملخص: مستلم − متبقٍ − مُرجَع = مباع/تالف/غيره)
async function returnedByModel(supplier) {
  const rows = await SupplierReturn.aggregate([
    { $match: { supplier: new mongoose.Types.ObjectId(String(supplier)), status: "applied" } },
    { $unwind: "$items" },
    { $group: { _id: "$items.model", qty: { $sum: "$items.qty" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.qty]));
}

module.exports = { create, findByKey, markApplied, deleteById, listBySupplier, returnedByModel };
