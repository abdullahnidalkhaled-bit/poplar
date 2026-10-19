const mongoose = require("mongoose");
const SupplierEntry = require("../models/supplierEntry.model");
const { sessionOpts } = require("../utils/unitOfWork");

const oid = (id) => new mongoose.Types.ObjectId(String(id));

const create = async (data, ctx) => {
  const [doc] = await SupplierEntry.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => SupplierEntry.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => SupplierEntry.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (idempotencyKey, ctx) => SupplierEntry.findOne({ idempotencyKey }, null, sessionOpts(ctx)).lean();
const allForSupplier = (supplierId, ctx) =>
  SupplierEntry.find({ supplier: supplierId }, null, sessionOpts(ctx)).sort({ date: 1, _id: 1 }).lean();
const linkedToInvoice = (invoiceId, ctx) =>
  SupplierEntry.find({ invoice: invoiceId }, null, sessionOpts(ctx)).lean();

// وسم "معكوس" يُضاف مرة واحدة فقط: مشروط بعدم وجود وسم سابق (يمنع عكساً مزدوجاً متزامناً)
const markReversed = (id, reversalId, ctx) =>
  SupplierEntry.findOneAndUpdate({ _id: id, reversedBy: { $exists: false } }, { $set: { reversedBy: reversalId } }, { returnDocument: "after", ...sessionOpts(ctx) });
const unmarkReversed = (id) => SupplierEntry.updateOne({ _id: id }, { $unset: { reversedBy: 1 } });

// أرصدة كل التجار (أو مجموعة) لكل عملة على حدة من القيود مباشرة بالوحدة الصغرى الأصلية. لا تحويل ولا جمع بين العملتين.
// للقيود القديمة بلا amountMinor يُشتق من المبلغ الأصلي بعملته مرة واحدة
const live = { $and: [{ $ne: ["$type", "reversal"] }, { $eq: [{ $ifNull: ["$reversedBy", null] }, null] }] };
const minor = { $ifNull: ["$amountMinor", { $cond: [{ $eq: ["$currency", "SYP"] }, { $round: ["$amount", 0] }, { $round: [{ $multiply: ["$amount", 100] }, 0] }] }] };
const sumIf = (types) => ({ $sum: { $cond: [{ $and: [live, { $in: ["$type", types] }] }, minor, 0] } });

// يعيد Map(supplierId -> { USD: {invoicedMinor, adjustmentsMinor, creditsMinor}, SYP: {...} })
async function balances(supplierIds) {
  const match = supplierIds ? { supplier: { $in: supplierIds.map(oid) } } : {};
  const rows = await SupplierEntry.aggregate([
    { $match: match },
    { $group: { _id: { supplier: "$supplier", currency: "$currency" }, invoicedMinor: sumIf(["purchase"]), adjustmentsMinor: sumIf(["adjustment"]), creditsMinor: sumIf(["payment", "advance", "credit", "return_credit"]) } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const k = String(r._id.supplier);
    if (!out.has(k)) out.set(k, { USD: { invoicedMinor: 0, adjustmentsMinor: 0, creditsMinor: 0 }, SYP: { invoicedMinor: 0, adjustmentsMinor: 0, creditsMinor: 0 } });
    out.get(k)[r._id.currency] = { invoicedMinor: r.invoicedMinor, adjustmentsMinor: r.adjustmentsMinor, creditsMinor: r.creditsMinor };
  }
  return out;
}

module.exports = { create, deleteById, findById, findByKey, allForSupplier, linkedToInvoice, markReversed, unmarkReversed, balances, oid };
