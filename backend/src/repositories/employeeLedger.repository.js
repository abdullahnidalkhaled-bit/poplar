const EmployeeLedger = require("../models/employeeLedger.model");
const { sessionOpts } = require("../utils/unitOfWork");

const create = async (data, ctx) => {
  const [doc] = await EmployeeLedger.create([data], sessionOpts(ctx));
  return doc.toObject();
};
// الحذف هنا تراجع تعويضي فقط عن قيد لم يكتمل ترحيله (الوضع غير المعاملاتي)؛ القيود المكتملة لا تُحذف أبداً
const deleteById = (id, ctx) => EmployeeLedger.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => EmployeeLedger.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (idempotencyKey, ctx) => EmployeeLedger.findOne({ idempotencyKey }, null, sessionOpts(ctx)).lean();
const setCash = (id, cash, ctx) => EmployeeLedger.updateOne({ _id: id }, { $set: { cash } }, sessionOpts(ctx));
const setLinks = (id, links, ctx) => EmployeeLedger.updateOne({ _id: id }, { $set: links }, sessionOpts(ctx));
const findByExpense = (expense) => EmployeeLedger.findOne({ expense, type: "salary_payment" }).lean();
const markReversed = (id, reversalId, ctx) =>
  EmployeeLedger.findOneAndUpdate({ _id: id, type: { $ne: "reversal" }, reversedBy: { $exists: false } }, { $set: { reversedBy: reversalId } }, { returnDocument: "after", ...sessionOpts(ctx) }).lean();
const unmarkReversed = (id) => EmployeeLedger.updateOne({ _id: id }, { $unset: { reversedBy: 1 } });

const list = async (filter, { skip, limit }) => {
  const [items, total] = await Promise.all([
    EmployeeLedger.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    EmployeeLedger.countDocuments(filter),
  ]);
  return { items, total };
};
const byPeriod = (period, ctx) => EmployeeLedger.find({ period }, null, sessionOpts(ctx)).sort({ date: 1, _id: 1 }).lean();
const byAdvance = (advance) => EmployeeLedger.find({ advance }).sort({ date: 1, _id: 1 }).lean();

module.exports = { create, deleteById, findById, findByKey, setCash, setLinks, findByExpense, markReversed, unmarkReversed, list, byPeriod, byAdvance };
