const mongoose = require("mongoose");
const { ORIGINS, MODEL_NUMBER_REGEX, SIZE_REGEX } = require("../config/constants");
const { tokenize, normalizeText } = require("../utils/text");

// مقاس واحد من الموديل: هوية فقط (الاسم + الباركود). الكميات تعيش في الأرتال (Series) وتُجمَّع منها دائماً.
// حقلا shopQty/warehouseQty القديمان يبقيان في القاعدة دون المساس (للتراجع) لكن الكود يتجاهلهما.
const sizeSchema = new mongoose.Schema({
  size: { type: String, required: true, trim: true, uppercase: true, match: [SIZE_REGEX, "مقاس غير صالح"] },
  // باركود المصنّع (أو داخلي) لهذا المقاس: يخدم مسح الكاشير. QR الموديل مستقل عنه
  barcode: { type: String, trim: true },
  legacyVariantId: mongoose.Schema.Types.ObjectId, // للربط مع بيانات النسخة السابقة
});

const productModelSchema = new mongoose.Schema(
  {
    modelNumber: {
      type: String, required: true, unique: true, trim: true, uppercase: true,
      match: [MODEL_NUMBER_REGEX, "رقم الموديل غير صالح"],
    },
    name: { type: String, required: true, trim: true },
    brand: { type: String, required: true, trim: true },
    origin: { type: String, enum: ORIGINS, required: true },
    type: { type: String, required: true, trim: true }, // بنطال، قميص، جاكيت...
    cut: { type: String, trim: true, default: "" },     // بوت كات، بوي فريند، سكيني...
    season: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    costPrice: { type: Number, required: true, min: 0 }, // دولار، متوسط مرجّح
    sellPrice: { type: Number, required: true, min: 0 }, // دولار
    sizes: {
      type: [sizeSchema],
      validate: [
        { validator: (a) => new Set(a.map((s) => s.size)).size === a.length, message: "مقاس مكرر داخل الموديل" },
        { validator: (a) => a.length > 0, message: "يجب تحديد مقاس واحد على الأقل" },
      ],
    },
    rev: { type: Number, default: 0 }, // يزداد مع كل تغيير مخزون: تحكم تفاؤلي بالتزامن
    active: { type: Boolean, default: true },
    // حقول بحث مشتقة (تُحدَّث تلقائياً)
    searchTokens: { type: [String], select: false },
    searchText: { type: String, select: false },
    legacy: { productId: mongoose.Schema.Types.ObjectId, color: String, style: String },
  },
  { timestamps: true, collection: "product_models" }
);

// مفاتيح البحث المطبّعة: كلمات الاسم والبراند والنوع والقَصّة وأجزاء رقم الموديل
productModelSchema.pre("validate", function () {
  const parts = [this.name, this.brand, this.type, this.cut, this.modelNumber];
  this.searchTokens = [...new Set(parts.flatMap(tokenize))];
  this.searchText = normalizeText(parts.join(" "));
});

productModelSchema.index({ "sizes.barcode": 1 }, { unique: true, partialFilterExpression: { "sizes.barcode": { $type: "string" } } });
productModelSchema.index({ searchTokens: 1 });
productModelSchema.index({ active: 1, brand: 1, type: 1 });
productModelSchema.index({ active: 1, updatedAt: -1 });

module.exports = mongoose.model("ProductModel", productModelSchema);
