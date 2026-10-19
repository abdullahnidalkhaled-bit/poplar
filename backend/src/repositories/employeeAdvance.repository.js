const EmployeeAdvance = require("../models/employeeAdvance.model");
const { sessionOpts } = require("../utils/unitOfWork");

const create = async (data, ctx) => {
  const [doc] = await EmployeeAdvance.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => EmployeeAdvance.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => EmployeeAdvance.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (idempotencyKey) => EmployeeAdvance.findOne({ idempotencyKey }).lean();
const hasAny = (employee) => EmployeeAdvance.exists({ employee });
const OPEN = ["pending", "disbursed", "partially_settled"];

// كل انتقال حالة تحديث واحد مشروط (compare-and-set): الطلب المتزامن الثاني يفشل ولا يمر
const disburse = (id, disbursement, ctx) =>
  EmployeeAdvance.findOneAndUpdate({ _id: id, status: "pending" }, { $set: { status: "disbursed", disbursement } }, { returnDocument: "after", ...sessionOpts(ctx) }).lean();
const undoDisburse = (id) => EmployeeAdvance.updateOne({ _id: id }, { $set: { status: "pending" }, $unset: { disbursement: 1 } });

const settle = (id, amountMinor, ctx) =>
  EmployeeAdvance.findOneAndUpdate(
    { _id: id, status: { $in: ["disbursed", "partially_settled"] }, $expr: { $gte: [{ $subtract: ["$amountMinor", "$settledMinor"] }, amountMinor] } },
    [
      { $set: { settledMinor: { $add: ["$settledMinor", amountMinor] }, updatedAt: "$$NOW" } },
      { $set: { status: { $cond: [{ $eq: ["$settledMinor", "$amountMinor"] }, "settled", "partially_settled"] } } },
    ],
    { returnDocument: "after", updatePipeline: true, ...sessionOpts(ctx) }
  ).lean();
const unsettle = (id, amountMinor, ctx) =>
  EmployeeAdvance.findOneAndUpdate(
    { _id: id, status: { $in: ["partially_settled", "settled"] }, settledMinor: { $gte: amountMinor } },
    [
      { $set: { settledMinor: { $subtract: ["$settledMinor", amountMinor] }, updatedAt: "$$NOW" } },
      { $set: { status: { $cond: [{ $gt: ["$settledMinor", 0] }, "partially_settled", "disbursed"] } } },
    ],
    { returnDocument: "after", updatePipeline: true, ...sessionOpts(ctx) }
  ).lean();
const undoSettle = (id, amountMinor) => unsettle(id, amountMinor);
const undoUnsettle = (id, amountMinor) =>
  EmployeeAdvance.findOneAndUpdate({ _id: id }, [
    { $set: { settledMinor: { $add: ["$settledMinor", amountMinor] } } },
    { $set: { status: { $cond: [{ $eq: ["$settledMinor", "$amountMinor"] }, "settled", "partially_settled"] } } },
  ], { updatePipeline: true });

// إلغاء سلفة لم تُصرف (cancelled) أو عكس سلفة مصروفة لم تُسوَّ منها أي قطعة (reversed)
const finish = (id, from, to, reversal, ctx) =>
  EmployeeAdvance.findOneAndUpdate({ _id: id, status: from, settledMinor: 0 }, { $set: { status: to, reversal } }, { returnDocument: "after", ...sessionOpts(ctx) }).lean();
const undoFinish = (id, from) => EmployeeAdvance.updateOne({ _id: id }, { $set: { status: from }, $unset: { reversal: 1 } });

const reassign = (id, fromPeriod, toPeriod, ctx) =>
  EmployeeAdvance.findOneAndUpdate({ _id: id, deductionPeriod: fromPeriod, status: { $in: ["pending", "disbursed"] }, settledMinor: 0 }, { $set: { deductionPeriod: toPeriod } }, { returnDocument: "after", ...sessionOpts(ctx) }).lean();

// ترحيل الرصيد غير المسوّى إلى فترة لاحقة (نظام): يسمح بوجود تسويات سابقة، وسجل التسويات يبقى مربوطاً بالسلفة نفسها
const carryForward = (id, fromPeriod, toPeriod, ctx) =>
  EmployeeAdvance.findOneAndUpdate({ _id: id, deductionPeriod: fromPeriod, status: { $in: ["disbursed", "partially_settled"] } }, { $set: { deductionPeriod: toPeriod } }, { returnDocument: "after", ...sessionOpts(ctx) }).lean();

const list = async (filter, { skip, limit }) => {
  const [items, total] = await Promise.all([
    EmployeeAdvance.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    EmployeeAdvance.countDocuments(filter),
  ]);
  return { items, total };
};
const byEmployees = (employees) => EmployeeAdvance.find({ employee: { $in: employees } }).lean();
const byEmployee = (employee) => EmployeeAdvance.find({ employee }).sort({ createdAt: -1 }).lean();
const byPeriod = (deductionPeriod) => EmployeeAdvance.find({ deductionPeriod }).sort({ createdAt: 1 }).lean();
const openByPeriod = (deductionPeriod, ctx) => EmployeeAdvance.find({ deductionPeriod, status: { $in: OPEN } }, null, sessionOpts(ctx)).lean();
// السلف المصروفة غير المسوّاة بالكامل لعدة موظفين دفعة واحدة
const outstandingByEmployees = (employees) =>
  EmployeeAdvance.aggregate([
    { $match: { employee: { $in: employees }, status: { $in: ["disbursed", "partially_settled"] } } },
    { $group: { _id: "$employee", minor: { $sum: { $subtract: ["$amountMinor", "$settledMinor"] } }, count: { $sum: 1 } } },
  ]);

module.exports = {
  carryForward, create, deleteById, findById, findByKey, hasAny, disburse, undoDisburse, settle, unsettle, undoSettle, undoUnsettle, finish, undoFinish, reassign,
  list, byEmployee, byEmployees, byPeriod, openByPeriod, outstandingByEmployees, OPEN,
};
