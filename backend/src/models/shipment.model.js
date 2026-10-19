const mongoose = require("mongoose");
const { LOCATIONS } = require("../config/constants");

// سجل شحنة مستلمة. المفتاح idempotencyKey الفريد يمنع تنفيذ نفس الطلب مرتين (نقرة مزدوجة/إعادة إرسال)
const shipmentSchema = new mongoose.Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true },
    modelNumber: { type: String, required: true },
    location: { type: String, enum: LOCATIONS, required: true },
    items: [{ _id: false, size: String, qty: Number }],
    series: [{ _id: false, seriesNo: String, sizes: [{ _id: false, size: String, qty: Number }] }], // تركيب الأرتال المطلوبة
    seriesIds: [mongoose.Schema.Types.ObjectId],
    unitCostUsd: Number,
    note: { type: String, default: "" },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    ownership: { type: String, enum: ["owned", "consignment"], default: "owned" },
    consignmentPrice: { amount: Number, currency: String, rate: Number },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierInvoice" }, // فاتورة الشراء المنشأة مع الاستلام (إن وُجدت)
    status: { type: String, enum: ["pending", "applied"], default: "pending" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Shipment", shipmentSchema);
