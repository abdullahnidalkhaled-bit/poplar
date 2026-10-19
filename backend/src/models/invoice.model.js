const mongoose = require("mongoose");

// بند الفاتورة يحفظ "نسخة" وقت البيع: لا يتغير ربح فاتورة قديمة مهما تغيّر الموديل لاحقاً
const itemSchema = new mongoose.Schema(
  {
    model: { type: mongoose.Schema.Types.ObjectId, ref: "ProductModel" },
    sizeId: mongoose.Schema.Types.ObjectId,
    modelNumber: String,
    name: String,
    brand: String,
    origin: String,
    type: String,
    cut: String,
    size: String,
    barcode: String,
    qty: { type: Number, required: true, min: 1 },
    returnedQty: { type: Number, default: 0, min: 0 },
    // من أي أرتال خُصمت القطع (FIFO): تعود إليها عند الإلغاء/الإرجاع. فواتير ما قبل الأرتال بلا توزيع.
    allocations: { type: [new mongoose.Schema({ series: mongoose.Schema.Types.ObjectId, seriesNo: String, qty: Number }, { _id: false })], default: undefined },
    costPrice: { type: Number, required: true },
    sellPrice: { type: Number, required: true },
    unitPrice: { type: Number, required: true },   // بعملة الفاتورة
    unitPriceUsd: { type: Number, required: true },
    flag: { type: String, enum: ["normal", "below_sell_price", "below_cost"], default: "normal" },
    // بيانات النسخة السابقة (قبل الترحيل) محفوظة للرجوع إليها
    legacy: { product: mongoose.Schema.Types.ObjectId, variantId: mongoose.Schema.Types.ObjectId, color: String, style: String },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },
    currency: { type: String, enum: ["USD", "SYP"], required: true },
    rate: { type: Number, default: 0 },
    items: { type: [itemSchema], validate: (v) => v.length > 0 },
    itemsCount: Number,
    totalPaid: Number,
    creditApplied: { type: Number, default: 0 },
    cashDue: Number,
    totalUsd: Number,
    costUsd: Number,
    profitUsd: Number,
    status: { type: String, enum: ["completed", "cancelled"], default: "completed" },
    cancelledAt: Date,
    note: { type: String, default: "" },
    returnRef: { type: mongoose.Schema.Types.ObjectId, ref: "Return" },
    exchangeOfInvoice: Number,
  },
  { timestamps: true }
);

invoiceSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Invoice", invoiceSchema);
