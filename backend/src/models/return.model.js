const mongoose = require("mongoose");

const returnItemSchema = new mongoose.Schema(
  {
    itemIndex: Number,
    model: mongoose.Schema.Types.ObjectId,
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
    condition: { type: String, enum: ["good", "damaged"], default: "good" },
    unitPrice: Number,
    unitPriceUsd: Number,
    costPrice: Number,
    legacy: { color: String, style: String },
  },
  { _id: false }
);

const returnSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, unique: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true },
    invoiceNumber: Number,
    mode: { type: String, enum: ["cash", "exchange"], required: true },
    reason: { type: String, default: "" },
    items: { type: [returnItemSchema], validate: (v) => v.length > 0 },
    currency: { type: String, enum: ["USD", "SYP"] },
    refundAmount: Number,
    refundUsd: Number,
    reversedProfitUsd: Number,
    writeOffUsd: { type: Number, default: 0 },
    rateAtReturn: { type: Number, default: 0 },
    refundUsdToday: Number,
    fxDiffUsd: { type: Number, default: 0 },
    cashRefund: { type: Number, default: 0 },
    exchangeInvoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
    exchangeInvoiceNumber: Number,
  },
  { timestamps: true }
);

returnSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Return", returnSchema);
