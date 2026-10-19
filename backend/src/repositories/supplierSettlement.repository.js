const SupplierSettlement = require("../models/supplierSettlement.model");
const { sessionOpts } = require("../utils/unitOfWork");

const create = async (data) => (await SupplierSettlement.create(data)).toObject();
const findById = (id) => SupplierSettlement.findById(id).lean();
const findByKey = (idempotencyKey) => SupplierSettlement.findOne({ idempotencyKey }).lean();
const deleteById = (id) => SupplierSettlement.deleteOne({ _id: id });
const markPosted = (id, invoice, entry) => SupplierSettlement.updateOne({ _id: id }, { $set: { status: "posted", invoice, entry } });
// عكس مرة واحدة فقط: مشروط بأن تكون الحالة posted
const markReversed = (id, reversal, ctx) =>
  SupplierSettlement.findOneAndUpdate({ _id: id, status: "posted" }, { $set: { status: "reversed", reversal } }, { returnDocument: "after", ...sessionOpts(ctx) });
const unmarkReversed = (id) => SupplierSettlement.updateOne({ _id: id }, { $set: { status: "posted" }, $unset: { reversal: 1 } });
const listBySupplier = (supplier, limit = 200) =>
  SupplierSettlement.find({ supplier, status: { $in: ["posted", "reversed"] } }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();

module.exports = { create, findById, findByKey, deleteById, markPosted, markReversed, unmarkReversed, listBySupplier };
