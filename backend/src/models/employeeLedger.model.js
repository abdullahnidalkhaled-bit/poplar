const mongoose = require("mongoose");
const { CURRENCIES, PAYROLL_LEDGER_TYPES } = require("../config/constants");

// دفتر الموظف المالي: للإلحاق فقط. لا تعديل ولا حذف. التصحيح بقيد عكسي (type=reversal) يُوسَم به الأصل مرة واحدة.
// amountMinor موجب دائماً؛ نوع القيد يحدد أثره (راجع utils/payroll.js). كل قيد بعملته الأصلية.
const ledgerSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true }, // EL-000001
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    period: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollPeriod" },
    advance: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeAdvance" },
    type: { type: String, enum: PAYROLL_LEDGER_TYPES, required: true },
    reverseOf: { type: String }, // نوع القيد الأصلي عند type=reversal
    currency: { type: String, enum: CURRENCIES, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isInteger },
    date: { type: Date, required: true },
    note: { type: String, default: "", maxlength: 500 },
    cash: { type: mongoose.Schema.Types.ObjectId, ref: "CashMovement" },
    expense: { type: mongoose.Schema.Types.ObjectId, ref: "Expense" }, // دفعة راتب مُسجَّلة عبر المالية ← المصروفات
    reverses: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeLedger" },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeLedger" },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String }, // بصمة الطلب المعتمدة المرتبطة بالمفتاح: إعادة المفتاح بمعطيات مختلفة تُرفض (409)
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "employee_ledger" }
);

ledgerSchema.index({ idempotencyKey: 1 }, { unique: true });
ledgerSchema.index({ employee: 1, date: -1, _id: -1 });
ledgerSchema.index({ period: 1, type: 1 });
ledgerSchema.index({ advance: 1, type: 1 });
ledgerSchema.index({ reverses: 1 }, { unique: true, partialFilterExpression: { reverses: { $type: "objectId" } } });

module.exports = mongoose.model("EmployeeLedger", ledgerSchema);
