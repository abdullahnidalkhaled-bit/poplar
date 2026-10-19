const mongoose = require("mongoose");
const { ROLES } = require("../config/permissions");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // اسم الدخول (أو البريد): مُطبَّع بأحرف صغيرة وفريد
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 64 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // صلاحيات الموظف الصريحة (الأدمن يملك الكل ويتجاهل هذا الحقل)
    permissions: { type: [String], default: undefined },
    active: { type: Boolean, default: true },
    // يُزاد عند تغيير الصلاحيات/كلمة المرور/التعطيل فتسقط كل الجلسات القائمة
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
