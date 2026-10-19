const mongoose = require("mongoose");
const { MOVEMENT_TYPES, LOCATIONS } = require("../config/constants");

const qtyPair = new mongoose.Schema({ shop: Number, warehouse: Number }, { _id: false });

// دفتر حركات المخزون. before/after تُسجَّل فقط حين تكون موثوقة (عمليات النسخة الجديدة)
const movementSchema = new mongoose.Schema(
  {
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    model: { type: mongoose.Schema.Types.ObjectId, ref: "ProductModel" },
    sizeId: mongoose.Schema.Types.ObjectId,
    // نسخة وصفية: يبقى السجل مقروءاً حتى لو تغيّر الموديل أو أُرشف
    modelNumber: String,
    name: String,
    nameKey: String, // الاسم مطبّعاً للبحث
    brand: String,
    size: String,
    qty: { type: Number, required: true },  // عدد القطع المتحركة (موجب)
    delta: { type: Number, default: 0 },    // الأثر على إجمالي المخزون
    from: { type: String, enum: [...LOCATIONS, null] },
    to: { type: String, enum: [...LOCATIONS, null] },
    before: { type: qtyPair, default: undefined },
    after: { type: qtyPair, default: undefined },
    costUsd: { type: Number, default: 0 },
    reason: { type: String, default: "" },
    ref: { type: String, default: "" },     // INV-12 / RET-3 / SHP-...
    batchId: String,                        // يجمع حركات شحنة واحدة
    // الأرتال التي مسّتها الحركة (التوزيع FIFO). في النقل: بنود المصدر (location=from) والوجهة (location=to)
    allocations: {
      type: [new mongoose.Schema({ series: mongoose.Schema.Types.ObjectId, seriesNo: String, qty: Number, location: String }, { _id: false })],
      default: undefined,
    },
    legacy: { color: String, style: String },
  },
  { timestamps: true }
);

movementSchema.index({ createdAt: -1 });
movementSchema.index({ type: 1, createdAt: -1 });
movementSchema.index({ modelNumber: 1, createdAt: -1 });
movementSchema.index({ model: 1, createdAt: -1 });
movementSchema.index({ "allocations.series": 1, createdAt: -1 });

module.exports = mongoose.model("StockMovement", movementSchema);
