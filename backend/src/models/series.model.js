const mongoose = require("mongoose");
const { LOCATIONS, OWNERSHIPS, SERIES_KINDS, SERIES_STATUSES, SIZE_REGEX } = require("../config/constants");

const qty = {
  type: Number,
  default: 0,
  min: [0, "الكمية لا يمكن أن تكون سالبة"],
  validate: { validator: Number.isInteger, message: "الكمية يجب أن تكون عدداً صحيحاً" },
};

// كمية مقاس داخل رتل. initialQty = ما استُلم مع الرتل، qty = المتبقي حالياً (المجاميع تُحسب ولا تُخزَّن)
const sizeQtySchema = new mongoose.Schema(
  {
    size: { type: String, required: true, trim: true, uppercase: true, match: [SIZE_REGEX, "مقاس غير صالح"] },
    initialQty: qty,
    qty,
    // ما سُوِّي مع التاجر من القطع المباعة من هذا المقاس (بضاعة الأمانة فقط). يزيده تحديث شرطي ذرّي فقط
    settledQty: { type: Number, default: 0, min: 0, validate: Number.isInteger },
  },
  { _id: false }
);

const seriesSchema = new mongoose.Schema(
  {
    seriesNo: { type: String, required: true, unique: true },
    model: { type: mongoose.Schema.Types.ObjectId, ref: "ProductModel", required: true },
    // نسخة وصفية للبحث والعرض
    modelNumber: { type: String, required: true },
    name: String,
    nameKey: String,
    type: String,
    cut: String,
    location: { type: String, enum: LOCATIONS, required: true },
    kind: { type: String, enum: SERIES_KINDS, required: true },
    originSeries: { type: mongoose.Schema.Types.ObjectId, ref: "Series" }, // للأرتال المشتقة فقط
    status: { type: String, enum: SERIES_STATUSES, default: "active" },
    sizes: { type: [sizeQtySchema], validate: (a) => new Set(a.map((s) => s.size)).size === a.length },
    receivedAt: { type: Date, default: Date.now },
    shipmentRef: String,
    // الملكية: الكميات تبقى مصدرها الأرتال وحدها؛ هذان الحقلان يحددان لمن تعود القطع فقط
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    ownership: { type: String, enum: OWNERSHIPS, default: "owned" },
    // اتفاق التسوية على بضاعة الأمانة: سعر القطعة المتفق عليه لهذا الرتل ولقطته (عملة + صرف)، وسجل تعديلاته للإلحاق فقط
    consignment: {
      price: { amount: Number, currency: { type: String, enum: ["USD", "SYP"] }, rate: Number },
      history: [{
        _id: false, kind: { type: String, enum: ["set", "adjust"] }, at: Date, reason: String, by: { id: mongoose.Schema.Types.ObjectId, name: String },
        previous: { amount: Number, currency: String, rate: Number }, price: { amount: Number, currency: String, rate: Number },
      }],
    },
    note: { type: String, default: "" },
    rev: { type: Number, default: 0 },
  },
  { timestamps: true }
);

seriesSchema.index({ model: 1, location: 1, status: 1, receivedAt: 1 });
seriesSchema.index({ location: 1, receivedAt: -1 });
seriesSchema.index({ modelNumber: 1 });
seriesSchema.index({ supplier: 1, ownership: 1, location: 1, status: 1 });
seriesSchema.index({ nameKey: 1 });
// رتل مشتق واحد لكل (أصل، وجهة) فتُدمج النقلات اللاحقة فيه
seriesSchema.index(
  { originSeries: 1, location: 1 },
  { unique: true, partialFilterExpression: { kind: "derived" } }
);
// رتل رصيد واحد لكل (موديل، موقع)
seriesSchema.index({ model: 1, location: 1 }, { unique: true, partialFilterExpression: { kind: "balance" } });

module.exports = mongoose.model("Series", seriesSchema);
