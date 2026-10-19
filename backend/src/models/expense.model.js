const mongoose = require("mongoose");
const { CURRENCIES } = require("../config/constants");

// مصروف تشغيلي مدفوع نقداً من صندوق عملته. يُعكس ولا يُحذف. القيد النقدي المرتبط هو الأثر على الصندوق.
const expenseSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true },            // EXP-000001
    currency: { type: String, enum: CURRENCIES, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isInteger },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: "", maxlength: 300 },
    date: { type: Date, required: true },
    status: { type: String, enum: ["posted", "reversed"], default: "posted" },
    cash: { type: mongoose.Schema.Types.ObjectId, ref: "CashMovement" },       // غائب عند الدفع من خارج الصندوق (لا حركة نقد وهمية)
    // مصروف راتب: يربط الموظف والفترة وقيد دفعة الراتب (الحساب كله في خدمة الرواتب)
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    periodKey: { type: String },
    payrollEntry: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeLedger" },
    method: { type: String, enum: ["cash", "other"], default: "cash" },
    idempotencyKey: { type: String, required: true, unique: true },
    reversal: { at: Date, reason: String, by: { id: mongoose.Schema.Types.ObjectId, name: String } },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true }
);

expenseSchema.index({ currency: 1, date: -1 });
expenseSchema.index({ category: 1, currency: 1 });
expenseSchema.index({ employee: 1, date: -1 }, { partialFilterExpression: { employee: { $type: "objectId" } } });

module.exports = mongoose.model("Expense", expenseSchema);
