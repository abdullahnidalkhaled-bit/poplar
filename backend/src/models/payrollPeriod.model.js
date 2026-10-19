const mongoose = require("mongoose");
const { CURRENCIES, PAYROLL_STATUSES } = require("../config/constants");

// فترة راتب واحدة لكل (موظف، مفتاح فترة YYYY-MM). كل المبالغ أعداد صحيحة بالوحدة الصغرى وبعملة الفترة.
//   الصافي المستحق = baseSalary + allowances + bonuses − deductions
//   المتبقي للدفع   = الصافي − settled (تسوية السلف) − paid (دفعات الراتب)
// العدّادات تُحدَّث بتحديثات ذرّية مشروطة فلا يتجاوز المتبقي الصفر مهما تزامنت الطلبات؛ دفتر الموظف هو السجل المرجعي.
const periodSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true }, // PAY-000001
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    baseSalaryMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },
    allowancesMinor: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    bonusesMinor: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    deductionsMinor: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    settledMinor: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    paidMinor: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    status: { type: String, enum: PAYROLL_STATUSES, default: "draft" },
    approvedAt: Date,
    approvedBy: { id: mongoose.Schema.Types.ObjectId, name: String },
    closedAt: Date,
    closedBy: { id: mongoose.Schema.Types.ObjectId, name: String },
    idempotencyKey: { type: String },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "payroll_periods" }
);

periodSchema.index({ employee: 1, periodKey: 1 }, { unique: true });
periodSchema.index({ periodKey: 1, status: 1 });
periodSchema.index({ status: 1, dueDate: 1 });
periodSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });

module.exports = mongoose.model("PayrollPeriod", periodSchema);
