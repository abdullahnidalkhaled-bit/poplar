const PayrollPeriod = require("../models/payrollPeriod.model");
const { sessionOpts } = require("../utils/unitOfWork");

// كل تحديث للعدّادات تحديث واحد ذرّي بخط أنابيب (pipeline) يفرض شرط "المتبقي ≥ 0" ويعيد اشتقاق الحالة داخل قاعدة البيانات.
// بذلك لا يستطيع طلبان متزامنان تجاوز المتبقي أو تكرار دفعة مهما كان ترتيبهما.
const FIELDS = ["allowancesMinor", "bonusesMinor", "deductionsMinor", "settledMinor", "paidMinor"];
const v = (f, d = {}) => (d[f] ? { $add: ["$" + f, d[f]] } : "$" + f);
const remainingAfter = (d = {}) => ({
  $subtract: [
    { $subtract: [{ $subtract: [{ $add: ["$baseSalaryMinor", v("allowancesMinor", d), v("bonusesMinor", d)] }, v("deductionsMinor", d)] }, v("settledMinor", d)] },
    v("paidMinor", d),
  ],
});
// الاشتقاق بعد تطبيق المرحلة الأولى (الحقول صارت بقيمها الجديدة)
const statusStage = {
  $set: {
    status: {
      $switch: {
        branches: [
          { case: { $in: ["$status", ["draft", "closed"]] }, then: "$status" },
          { case: { $eq: [remainingAfter(), 0] }, then: "paid" },
          { case: { $gt: [{ $add: ["$settledMinor", "$paidMinor"] }, 0] }, then: "partially_paid" },
        ],
        default: "approved",
      },
    },
    updatedAt: "$$NOW",
  },
};
const apply = (deltas) => ({ $set: Object.fromEntries(FIELDS.filter((f) => deltas[f]).map((f) => [f, v(f, deltas)])) });

const create = async (data, ctx) => {
  const [doc] = await PayrollPeriod.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => PayrollPeriod.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => PayrollPeriod.findById(id, null, sessionOpts(ctx)).lean();
const findByKey = (idempotencyKey) => PayrollPeriod.findOne({ idempotencyKey }).lean();
const findByEmployeeAndKey = (employee, periodKey) => PayrollPeriod.findOne({ employee, periodKey }).lean();
const hasAny = (employee) => PayrollPeriod.exists({ employee });

/** تعديل ذرّي مشروط للعدّادات. يعيد المستند بعد التعديل أو null إذا لم يتحقق الشرط (حالة/متبقي) */
const adjust = (id, deltas, statuses, ctx) => {
  const nonNeg = FIELDS.filter((f) => deltas[f] < 0).map((f) => ({ $gte: [v(f, deltas), 0] }));
  return PayrollPeriod.findOneAndUpdate(
    { _id: id, status: { $in: statuses }, $expr: { $and: [{ $gte: [remainingAfter(deltas), 0] }, ...nonNeg] } },
    [apply(deltas), statusStage],
    { returnDocument: "after", updatePipeline: true, ...sessionOpts(ctx) }
  ).lean();
};
// تراجع تعويضي (بلا شروط) عن adjust عند فشل خطوة لاحقة في الوضع غير المعاملاتي
const undoAdjust = (id, deltas) => {
  const inverse = Object.fromEntries(Object.entries(deltas).map(([k, d]) => [k, -d]));
  return PayrollPeriod.updateOne({ _id: id }, [apply(inverse), statusStage], { updatePipeline: true });
};

// بدل/مكافأة/استقطاع: في المسودة، أو في فترة معتمدة لم يُدفع منها ولم يُسوَّ عليها شيء بعد (الاعتماد التلقائي لا يمنع إضافتها قبل أول دفعة)
const adjustComponent = (id, deltas, ctx) => {
  const nonNeg = FIELDS.filter((f) => deltas[f] < 0).map((f) => ({ $gte: [v(f, deltas), 0] }));
  return PayrollPeriod.findOneAndUpdate(
    { _id: id, $or: [{ status: "draft" }, { status: "approved", paidMinor: 0, settledMinor: 0 }], $expr: { $and: [{ $gte: [remainingAfter(deltas), 0] }, ...nonNeg] } },
    [apply(deltas), statusStage],
    { returnDocument: "after", updatePipeline: true, ...sessionOpts(ctx) }
  ).lean();
};
const approve = (id, by, ctx) =>
  PayrollPeriod.findOneAndUpdate({ _id: id, status: "draft" }, [{ $set: { status: "approved", approvedAt: "$$NOW", approvedBy: by } }, statusStage], { returnDocument: "after", updatePipeline: true, ...sessionOpts(ctx) }).lean();
const undoApprove = (id) => PayrollPeriod.updateOne({ _id: id }, { $set: { status: "draft" }, $unset: { approvedAt: 1, approvedBy: 1 } });
const close = (id, by, ctx) =>
  PayrollPeriod.findOneAndUpdate({ _id: id, status: "paid" }, { $set: { status: "closed", closedAt: new Date(), closedBy: by } }, { returnDocument: "after", ...sessionOpts(ctx) }).lean();

const list = async (filter, { skip, limit }) => {
  const [items, total] = await Promise.all([
    PayrollPeriod.find(filter).sort({ periodKey: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    PayrollPeriod.countDocuments(filter),
  ]);
  return { items, total };
};
const byEmployees = (employees) => PayrollPeriod.find({ employee: { $in: employees } }).lean();
const byEmployee = (employee) => PayrollPeriod.find({ employee }).sort({ periodKey: -1 }).lean();
const forEmployeesInPeriod = (employees, periodKey) => PayrollPeriod.find({ employee: { $in: employees }, periodKey }).lean();
// أقرب استحقاق لم يُسدَّد بعد لكل موظف (دفعة واحدة بدل استعلام لكل موظف)
const nextDueByEmployees = (employees) =>
  PayrollPeriod.aggregate([
    { $match: { employee: { $in: employees }, status: { $in: ["draft", "approved", "partially_paid"] } } },
    { $group: { _id: "$employee", dueDate: { $min: "$dueDate" } } },
  ]);

module.exports = { adjustComponent, create, deleteById, findById, findByKey, findByEmployeeAndKey, hasAny, adjust, undoAdjust, approve, undoApprove, close, list, byEmployee, byEmployees, forEmployeesInPeriod, nextDueByEmployees };
