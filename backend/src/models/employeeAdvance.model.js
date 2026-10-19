const mongoose = require("mongoose");
const { CURRENCIES, ADVANCE_STATUSES } = require("../config/constants");

// سلفة موظف. الإنشاء لا يعني صرف المال: الصرف خطوة صريحة (disburse) تنشئ حركة نقد حقيقية فقط إن كان الصرف نقدياً.
// فترة الخصم تُحدَّد صراحةً عند الإنشاء ولا تتغيّر إلا بإجراء إعادة إسناد صريح (قبل أي تسوية وفي فترة غير مغلقة).
// settledMinor = ما سُوِّي فعلاً من الراتب. المتبقي = amountMinor − settledMinor.
const by = { id: mongoose.Schema.Types.ObjectId, name: String };
const advanceSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true }, // ADV-000001
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isInteger },
    settledMinor: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    deductionPeriod: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollPeriod", required: true },
    status: { type: String, enum: ADVANCE_STATUSES, default: "pending" },
    requestedDate: { type: Date, required: true },
    disbursement: { at: Date, method: { type: String, enum: ["cash", "other"] }, cash: { type: mongoose.Schema.Types.ObjectId, ref: "CashMovement" }, by },
    reversal: { at: Date, reason: String, by },
    note: { type: String, default: "", maxlength: 500 },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String }, // بصمة طلب التسجيل المرتبطة بالمفتاح
    createdBy: by,
  },
  { timestamps: true, collection: "employee_advances" }
);

advanceSchema.index({ idempotencyKey: 1 }, { unique: true });
advanceSchema.index({ employee: 1, status: 1, createdAt: -1 });
advanceSchema.index({ deductionPeriod: 1, status: 1 });
advanceSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("EmployeeAdvance", advanceSchema);
