const mongoose = require("mongoose");
const SupplierAllocation = require("../models/supplierAllocation.model");
const { sessionOpts } = require("../utils/unitOfWork");

const oid = (id) => new mongoose.Types.ObjectId(String(id));

const create = async (data, ctx) => {
  const [doc] = await SupplierAllocation.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => SupplierAllocation.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => SupplierAllocation.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (idempotencyKey, ctx) => SupplierAllocation.findOne({ idempotencyKey }, null, sessionOpts(ctx)).lean();
const allForSupplier = (supplier, ctx) => SupplierAllocation.find({ supplier }, null, sessionOpts(ctx)).sort({ createdAt: 1, _id: 1 }).lean();
const forEntry = (entry, ctx) => SupplierAllocation.find({ entry }, null, sessionOpts(ctx)).lean();
const forInvoice = (invoice, ctx) => SupplierAllocation.find({ invoice }, null, sessionOpts(ctx)).lean();

// وسم "محرَّر" مرة واحدة فقط (يمنع تحريراً مزدوجاً متزامناً)
const markReleased = (id, releaseId, ctx) =>
  SupplierAllocation.findOneAndUpdate({ _id: id, kind: "apply", releasedBy: { $exists: false } }, { $set: { releasedBy: releaseId } }, { returnDocument: "after", ...sessionOpts(ctx) });
const unmarkReleased = (id) => SupplierAllocation.updateOne({ _id: id }, { $unset: { releasedBy: 1 } });

// مجموع التخصيصات السارية: Map(supplierId -> { inv: {USD, SYP}, credit: {USD, SYP} }) بوحدات صغرى أصلية. المراجَعة اليدوية (needsReview) مستبعدة
async function allocatedBySupplier(supplierIds) {
  const match = { kind: "apply", releasedBy: { $exists: false }, needsReview: { $ne: true }, ...(supplierIds ? { supplier: { $in: supplierIds.map(oid) } } : {}) };
  const rows = await SupplierAllocation.aggregate([
    { $match: match },
    { $group: { _id: { supplier: "$supplier", cur: "$currency", cc: "$creditCurrency" }, inv: { $sum: "$amountMinor" }, credit: { $sum: { $ifNull: ["$creditMinor", "$amountMinor"] } } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const k = String(r._id.supplier);
    if (!out.has(k)) out.set(k, { inv: { USD: 0, SYP: 0 }, credit: { USD: 0, SYP: 0 } });
    const o = out.get(k);
    if (r._id.cur) o.inv[r._id.cur] += r.inv;
    if (r._id.cc || r._id.cur) o.credit[r._id.cc || r._id.cur] += r.credit;
  }
  return out;
}

module.exports = { create, deleteById, findById, findByKey, allForSupplier, forEntry, forInvoice, markReleased, unmarkReleased, allocatedBySupplier };
