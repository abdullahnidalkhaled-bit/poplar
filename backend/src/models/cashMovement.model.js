const mongoose = require("mongoose");
const { CURRENCIES, CASH_TYPES } = require("../config/constants");

// دفتر الصندوقين (الليرة والدولار): المصدر الوحيد لأرصدة النقد. للإلحاق فقط ولا يُعدَّل ولا يُحذف.
// كل حركة بعملة واحدة وبوحدتها الصغرى الصحيحة (سنت للدولار، ليرة كاملة للسوري). لا تحويل ولا جمع بين الصندوقين.
// التصحيح يكون بحركة عكسية (reverses) تُوسَم الأصلية بها مرة واحدة. الفواتير والمستحقات لا تنشئ حركات نقد: الدفع الفعلي فقط.
const cashSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true },            // CSH-000001
    currency: { type: String, enum: CURRENCIES, required: true },    // الصندوق المتأثر = عملة الحركة الفعلية
    direction: { type: String, enum: ["in", "out"], required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isInteger },
    type: { type: String, enum: CASH_TYPES, required: true },
    source: {                                                        // مرجع المعاملة الأصلية
      kind: { type: String, enum: ["invoice", "return", "supplier_entry", "expense", "manual", "employee_advance", "payroll_payment"], required: true },
      id: mongoose.Schema.Types.ObjectId,
      ref: String,
    },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    date: { type: Date, required: true },                            // تاريخ الحركة الفعلي
    note: { type: String, default: "", maxlength: 500 },
    reverses: { type: mongoose.Schema.Types.ObjectId, ref: "CashMovement" },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "CashMovement" },
    idempotencyKey: { type: String, required: true },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "cash_movements" }
);

cashSchema.index({ idempotencyKey: 1 }, { unique: true });
cashSchema.index({ currency: 1, date: -1, _id: -1 });
cashSchema.index({ "source.kind": 1, "source.id": 1 });
cashSchema.index({ reverses: 1 }, { unique: true, partialFilterExpression: { reverses: { $type: "objectId" } } });
cashSchema.index({ type: 1, currency: 1, date: -1 });

module.exports = mongoose.model("CashMovement", cashSchema);
