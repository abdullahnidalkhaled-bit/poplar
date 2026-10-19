const mongoose = require("mongoose");
const { LOCATIONS } = require("../config/constants");

// إرجاع بضاعة أمانة إلى التاجر. المفتاح idempotencyKey الفريد يمنع تنفيذ الطلب مرتين
const itemSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: "Series", required: true },
    seriesNo: String,
    model: mongoose.Schema.Types.ObjectId,
    modelNumber: String,
    name: String,
    size: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    agreedUnit: { amount: Number, currency: { type: String, enum: ["USD", "SYP"] } }, // سعر الاتفاق بعملته وقت الإرجاع؛ غائب = لا سعر مسجّل
    location: { type: String, enum: LOCATIONS, required: true },
  },
  { _id: false }
);

const supplierReturnSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },
    ref: { type: String, required: true }, // SRT-000001
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    items: { type: [itemSchema], default: [] },
    totalQty: { type: Number, default: 0 },
    // قيمة تقديرية بأسعار الاتفاق لكل عملة على حدة (مرجعية، لا تُجمع عبر العملتين ولا تُعدّ قيداً مالياً)
    value: { USD: { type: Number, default: 0 }, SYP: { type: Number, default: 0 } },
    valueUsd: Number,
    unpricedQty: { type: Number, default: 0 }, // قطع بلا سعر اتفاق مسجّل: بحاجة لمطابقة يدوية
    reason: { type: String, default: "", maxlength: 300 },
    status: { type: String, enum: ["pending", "applied"], default: "pending" },
    entry: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierEntry" }, // قيد الدائن المرتبط (إن لزم)
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "supplier_returns" }
);

supplierReturnSchema.index({ supplier: 1, createdAt: -1 });

module.exports = mongoose.model("SupplierReturn", supplierReturnSchema);
