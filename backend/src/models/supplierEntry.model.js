const mongoose = require("mongoose");
const { SUPPLIER_ENTRY_TYPES, CURRENCIES } = require("../config/constants");

// دفتر حسابات التاجر: قيود لا تُعدَّل ولا تُحذف. التصحيح بقيد عكسي (type=reversal).
// كل قيد بعملته الأصلية وبوحدتها الصغرى الصحيحة (amountMinor: سنت للدولار / ليرة للسوري). لا تحويل ولا جمع بين العملتين.
// signedMinor موقَّع: موجب = يزيد ما على المحل للتاجر (فاتورة/تسوية مدينة)، سالب = يخفضه (دفعة/سلفة/إشعار دائن/ائتمان إرجاع).
// valuationUsdMinor: معادل دولاري تاريخي للتوثيق فقط (يُحفظ إن أُدخل سعر صرف صراحةً) ولا يدخل في أي رصيد أو نقد.
const entrySchema = new mongoose.Schema(
  {
    ref: { type: String, required: true, unique: true }, // SUP-000123
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    type: { type: String, enum: SUPPLIER_ENTRY_TYPES, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    amount: { type: Number, required: true }, // موجب بالوحدة الكبرى (للعرض)
    amountMinor: { type: Number, validate: Number.isInteger }, // مصدر الحقيقة (بعملة القيد)
    signedMinor: { type: Number, validate: Number.isInteger },
    rate: { type: Number, default: 0 }, // سعر صرف مُدخَل صراحةً (توثيق)
    valuationUsdMinor: { type: Number, validate: Number.isInteger },
    // دفع بعملة تختلف عن عملة الفاتورة: لا يُسمح إلا بتأكيد صريح مع المبلغ المُسوّى بعملة الفاتورة وسعر الصرف المُدخَل
    crossCurrency: { invoiceCurrency: String, settlesMinor: Number, rate: Number },
    // حقول الإصدار السابق (قيم دولارية موحّدة): تُقرأ للتوافق فقط ولا تُكتب
    delta: Number, amountUsd: Number, usdMinor: Number, deltaMinor: Number,
    date: { type: Date, required: true }, // التاريخ المحاسبي للقيد
    note: { type: String, default: "", maxlength: 500 },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierInvoice" },
    supplierReturn: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierReturn" },
    reverses: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierEntry" },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierEntry" }, // وسم وحيد يُضاف مرة واحدة عند العكس
    idempotencyKey: { type: String },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "supplier_entries" }
);

entrySchema.index({ supplier: 1, date: 1, _id: 1 });
entrySchema.index({ invoice: 1 });
entrySchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
entrySchema.index({ reverses: 1 }, { unique: true, partialFilterExpression: { reverses: { $type: "objectId" } } }); // قيد عكسي واحد لكل قيد

module.exports = mongoose.model("SupplierEntry", entrySchema);
