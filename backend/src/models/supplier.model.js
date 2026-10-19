const mongoose = require("mongoose");

// تاجر/مورّد. لا يُحذف أبداً (التعطيل فقط): تاريخه المالي والمخزني يبقى مرتبطاً به.
// nameKey/phoneKey حقول بحث وكشف تكرار مشتقة (تطبيع الاسم وأرقام الهاتف فقط)
const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameKey: { type: String, required: true },
    phone: { type: String, trim: true, default: "", maxlength: 40 },
    phoneKey: { type: String, default: "" },
    address: { type: String, trim: true, default: "", maxlength: 300 },
    notes: { type: String, trim: true, default: "", maxlength: 1000 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

supplierSchema.index({ nameKey: 1 });
supplierSchema.index({ phoneKey: 1 });
supplierSchema.index({ active: 1, createdAt: -1 });

module.exports = mongoose.model("Supplier", supplierSchema);
