const mongoose = require("mongoose");
const { CURRENCIES } = require("../config/constants");

// سجل تخصيص الأرصدة الدائنة (دفعات/سلف/إشعارات) على فواتير التاجر. للإلحاق فقط:
// الإلغاء بسجل "release" يشير إلى الأصل ويوسمه releasedBy، فيبقى تاريخ التخصيص كاملاً.
// التخصيص لا ينشئ حركة نقد: المال خرج عند دفع السلفة/الدفعة أصلاً.
// الأصل أن يكون التخصيص بعملة واحدة (amountMinor = creditMinor). عند اختلاف العملتين لا يُسمح إلا بتأكيد صريح:
// amountMinor بعملة الفاتورة، creditMinor بعملة الرصيد الدائن، و rate مُدخَل صراحةً؛ لا يُشتق شيء تلقائياً.
const allocationSchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true }, // ALC-000123
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    kind: { type: String, enum: ["apply", "release"], required: true },
    entry: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierEntry", required: true }, // القيد الدائن
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierInvoice", required: true },
    currency: { type: String, enum: CURRENCIES },        // عملة الفاتورة (ما قابله amountMinor)
    amountMinor: { type: Number, required: true, min: 1, validate: Number.isInteger },
    creditCurrency: { type: String, enum: CURRENCIES },  // عملة الرصيد الدائن
    creditMinor: { type: Number, min: 1, validate: Number.isInteger },
    crossCurrency: { type: Boolean, default: false },
    rate: { type: Number, default: 0 },
    needsReview: { type: Boolean, default: false },      // سجل قديم بوحدات غامضة: يُستبعد من الأرصدة حتى المراجعة اليدوية
    source: { type: String, enum: ["direct", "manual", "auto", "release"], required: true }, // direct = دفعة مرتبطة بفاتورة عند التسجيل
    releases: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierAllocation" },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierAllocation" },
    note: { type: String, default: "", maxlength: 500 },
    idempotencyKey: { type: String },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "supplier_allocations" }
);

allocationSchema.index({ supplier: 1, createdAt: 1 });
allocationSchema.index({ entry: 1 });
allocationSchema.index({ invoice: 1 });
allocationSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
allocationSchema.index({ releases: 1 }, { unique: true, partialFilterExpression: { releases: { $type: "objectId" } } });

module.exports = mongoose.model("SupplierAllocation", allocationSchema);
