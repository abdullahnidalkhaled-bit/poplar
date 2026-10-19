const mongoose = require("mongoose");

module.exports = mongoose.model(
  "Setting",
  new mongoose.Schema({
    key: { type: String, default: "main", unique: true },
    usdToSyp: { type: Number, default: 0, min: 0 },       // كم ل.س = 1 دولار
    lowStockThreshold: { type: Number, default: 2, min: 0 }, // مهمل: لا تنبيه انخفاض بعد الآن (الحرج صفر المحل فقط). يبقى للتوافق
  })
);
