const mongoose = require("mongoose");
const { CURRENCIES } = require("../config/constants");

// تسوية بضاعة أمانة مباعة: وحدها تنشئ التزاماً للتاجر، وبعملة واحدة هي عملة سعر الاتفاق (لا تُخلط عملتان في تسوية).
// تحفظ لقطة السعر المتفق عليه لكل بند فلا يتغير بتعديل لاحق. لا تنشئ حركة نقد (الالتزام ليس دفعاً).
// الكمية المسوّاة تُسجَّل أيضاً على مقاس الرتل (settledQty) بتحديث شرطي ذرّي يمنع تسوية القطعة المباعة مرتين.
const itemSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: "Series", required: true },
    seriesNo: String,
    model: mongoose.Schema.Types.ObjectId,
    modelNumber: String,
    name: String,
    size: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitAmount: { type: Number, required: true },           // سعر القطعة المتفق عليه بعملته (وحدة كبرى)
    currency: { type: String, enum: CURRENCIES, required: true },
    rate: { type: Number, default: 0 },                       // توثيق فقط
    lineAmount: { type: Number, required: true },             // qty × unitAmount بالوحدة الكبرى
    lineMinor: { type: Number, validate: Number.isInteger },  // نفسه بالوحدة الصغرى الصحيحة (مصدر الحقيقة)
    lineUsdMinor: Number,                                     // الإصدار السابق: قراءة فقط
  },
  { _id: false }
);

const settlementSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },
    ref: { type: String, required: true },                    // SST-000001
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    currency: { type: String, enum: CURRENCIES },
    items: { type: [itemSchema], default: [] },
    totalQty: { type: Number, default: 0 },
    totalMinor: { type: Number, validate: Number.isInteger },
    totalUsdMinor: Number,                                    // الإصدار السابق: قراءة فقط
    note: { type: String, default: "", maxlength: 500 },
    status: { type: String, enum: ["pending", "posted", "reversed"], default: "pending" },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierInvoice" },
    entry: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierEntry" },
    reversal: { at: Date, reason: String, by: { id: mongoose.Schema.Types.ObjectId, name: String }, entry: mongoose.Schema.Types.ObjectId },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "supplier_settlements" }
);

settlementSchema.index({ supplier: 1, createdAt: -1 });

module.exports = mongoose.model("SupplierSettlement", settlementSchema);
