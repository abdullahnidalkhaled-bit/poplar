const CashMovement = require("../models/cashMovement.model");
const Expense = require("../models/expense.model");
const { sessionOpts } = require("../utils/unitOfWork");

// ---------- حركات النقد ----------
const create = async (data, ctx) => {
  const [doc] = await CashMovement.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => CashMovement.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => CashMovement.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (idempotencyKey, ctx) => CashMovement.findOne({ idempotencyKey }, null, sessionOpts(ctx)).lean();
const bySource = (kind, id, ctx) => CashMovement.find({ "source.kind": kind, "source.id": id }, null, sessionOpts(ctx)).sort({ _id: 1 }).lean();
const markReversed = (id, reversalId, ctx) =>
  CashMovement.findOneAndUpdate({ _id: id, reversedBy: { $exists: false }, reverses: { $exists: false } }, { $set: { reversedBy: reversalId } }, { returnDocument: "after", ...sessionOpts(ctx) });
const unmarkReversed = (id) => CashMovement.updateOne({ _id: id }, { $unset: { reversedBy: 1 } });

// الرصيد = مجموع الواردات − مجموع الصادرات لكل عملة، من الحركات المرحَّلة (العكسيات حركات عادية بالاتجاه المعاكس)
async function totals(match = {}) {
  const rows = await CashMovement.aggregate([
    { $match: match },
    { $group: { _id: { currency: "$currency", direction: "$direction" }, minor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
  ]);
  const out = { USD: { in: 0, out: 0, count: 0 }, SYP: { in: 0, out: 0, count: 0 } };
  for (const r of rows) { out[r._id.currency][r._id.direction] += r.minor; out[r._id.currency].count += r.count; }
  return out;
}

// حسب النوع لكل عملة (لدفعات الموردين والمصروفات في لوحة المالية)
async function totalsByType(match = {}) {
  const rows = await CashMovement.aggregate([
    { $match: match },
    { $group: { _id: { currency: "$currency", type: "$type", direction: "$direction" }, minor: { $sum: "$amountMinor" } } },
  ]);
  const out = { USD: {}, SYP: {} };
  for (const r of rows) {
    const t = (out[r._id.currency][r._id.type] = out[r._id.currency][r._id.type] || { in: 0, out: 0 });
    t[r._id.direction] += r.minor;
  }
  return out;
}

// سلسلة يومية لكل عملة (واردات/صادرات)
async function daily(match, tz) {
  const day = { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: tz } };
  const rows = await CashMovement.aggregate([
    { $match: match },
    { $group: { _id: { day, currency: "$currency", direction: "$direction" }, minor: { $sum: "$amountMinor" } } },
  ]);
  return rows;
}

const list = async (filter, { skip, limit }) => {
  const [items, total] = await Promise.all([
    CashMovement.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CashMovement.countDocuments(filter),
  ]);
  return { items, total };
};

// ---------- المصروفات ----------
const createExpense = async (data, ctx) => {
  const [doc] = await Expense.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteExpense = (id, ctx) => Expense.deleteOne({ _id: id }, sessionOpts(ctx));
const findExpense = (id, ctx) => Expense.findById(id, null, sessionOpts(ctx)).lean();
const findExpenseByKey = (idempotencyKey, ctx) => Expense.findOne({ idempotencyKey }, null, sessionOpts(ctx)).lean();
const setExpenseCash = (id, cash, ctx) => Expense.updateOne({ _id: id }, { $set: { cash } }, sessionOpts(ctx));
const markExpenseReversed = (id, reversal, ctx) =>
  Expense.findOneAndUpdate({ _id: id, status: "posted" }, { $set: { status: "reversed", reversal } }, { returnDocument: "after", ...sessionOpts(ctx) });
const unmarkExpenseReversed = (id) => Expense.updateOne({ _id: id }, { $set: { status: "posted" }, $unset: { reversal: 1 } });
const listExpenses = async (filter, { skip, limit }) => {
  const [items, total] = await Promise.all([
    Expense.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Expense.countDocuments(filter),
  ]);
  return { items, total };
};
// مجموع المصروفات السارية لكل عملة وفئة (يستثني المعكوسة)
async function expenseTotals(range) {
  const rows = await Expense.aggregate([
    { $match: { status: "posted", ...(range ? { date: range } : {}) } },
    { $group: { _id: { currency: "$currency", category: "$category" }, minor: { $sum: "$amountMinor" } } },
  ]);
  return rows;
}

module.exports = {
  create, deleteById, findById, findByKey, bySource, markReversed, unmarkReversed, totals, totalsByType, daily, list,
  createExpense, deleteExpense, findExpense, findExpenseByKey, setExpenseCash, markExpenseReversed, unmarkExpenseReversed, listExpenses, expenseTotals,
};
