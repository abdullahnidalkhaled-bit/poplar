const SupplierInvoice = require("../models/supplierInvoice.model");
const { sessionOpts } = require("../utils/unitOfWork");

const create = async (data, ctx) => {
  const [doc] = await SupplierInvoice.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => SupplierInvoice.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => SupplierInvoice.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (supplier, invoiceKey) => SupplierInvoice.findOne({ supplier, invoiceKey }).lean();
const listBySupplier = (supplier, ctx) => SupplierInvoice.find({ supplier }, null, sessionOpts(ctx)).sort({ invoiceDate: -1, _id: -1 }).lean();
const setEntry = (id, entry, ctx) => SupplierInvoice.updateOne({ _id: id }, { $set: { entry } }, sessionOpts(ctx));
const markReversed = (id, ctx) =>
  SupplierInvoice.findOneAndUpdate({ _id: id, status: "posted" }, { $set: { status: "reversed" } }, { returnDocument: "after", ...sessionOpts(ctx) });
const unmarkReversed = (id) => SupplierInvoice.updateOne({ _id: id }, { $set: { status: "posted" } });

module.exports = { create, deleteById, findById, findByKey, listBySupplier, setEntry, markReversed, unmarkReversed };
