const mongoose = require("mongoose");
const { CURRENCIES } = require("../config/constants");

// فاتورة مورّد (التزام مالي بعملتها). منفصلة عن فواتير الزبائن وعن استلام المخزون ولا تنشئ حركة نقد.
// المدفوع/المتبقي لا يُخزَّن: يُحسب من سجل التخصيص (بعملة الفاتورة)
const supplierInvoiceSchema = new mongoose.Schema(
  {
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true },
    invoiceNo: { type: String, required: true, trim: true, maxlength: 60 },
    invoiceKey: { type: String, required: true }, // رقم الفاتورة مطبّعاً (فريد لكل تاجر)
    // purchase = شراء عادي، consignment_settlement = تسوية بضاعة أمانة مباعة (تُنشأ من مسار التسوية فقط)
    kind: { type: String, enum: ["purchase", "consignment_settlement"], default: "purchase" },
    invoiceDate: { type: Date, required: true },
    dueDate: Date,
    currency: { type: String, enum: CURRENCIES, required: true },
    amount: { type: Number, required: true, min: 0 }, // بالوحدة الكبرى للعرض
    amountMinor: { type: Number, validate: Number.isInteger }, // مصدر الحقيقة بعملة الفاتورة
    rate: { type: Number, default: 0 }, // صرف مُدخَل صراحةً (توثيق فقط)
    valuationUsdMinor: { type: Number, validate: Number.isInteger },
    amountUsd: Number, amountUsdMinor: Number, // الإصدار السابق: قراءة فقط
    terms: { type: String, default: "", maxlength: 200 },
    note: { type: String, default: "", maxlength: 500 },
    seriesNos: { type: [String], default: [] }, // أرتال/شحنات مرتبطة (مرجعية فقط)
    shipmentRefs: { type: [String], default: [] },
    status: { type: String, enum: ["posted", "reversed"], default: "posted" },
    entry: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierEntry" },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "supplier_invoices" }
);

supplierInvoiceSchema.index({ supplier: 1, invoiceKey: 1 }, { unique: true });
supplierInvoiceSchema.index({ supplier: 1, invoiceDate: -1 });

module.exports = mongoose.model("SupplierInvoice", supplierInvoiceSchema);
