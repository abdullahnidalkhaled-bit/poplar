const mongoose = require("mongoose");
const { CURRENCIES, EMPLOYEE_STATUSES } = require("../config/constants");

// ملف الموظف المالي (غير حساب الدخول): الراتب بالوحدة الصغرى الصحيحة (سنت للدولار / ليرة للسوري) وبعملة واحدة.
// تغيير الراتب لا يمسّ الفترات القائمة: كل فترة تحمل لقطة (snapshot) من الراتب عند إنشائها.
// حساب الدخول (user) اختياري وفريد: موظف واحد لكل حساب.
const employeeSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true }, // EMP-000001
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameKey: { type: String, required: true },
    jobTitle: { type: String, default: "", maxlength: 80 },
    phone: { type: String, default: "", maxlength: 40 },
    hireDate: { type: Date },
    status: { type: String, enum: EMPLOYEE_STATUSES, default: "active" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    salaryMinor: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, enum: CURRENCIES, required: true },
    payDay: { type: Number, min: 1, max: 28, default: 1 }, // يوم استحقاق الراتب الشهري
    // أول شهر (YYYY-MM) يُعرف أن الراتب الحالي سارٍ فيه. يُضبط عند كل تغيير راتب (الشهر الحالي) أو بتصريح صريح؛ وإن غاب فشهر إنشاء السجل. لا تُنشأ فترات أقدم منه تلقائياً.
    salaryEffectiveFrom: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    notes: { type: String, default: "", maxlength: 500 },
    createdBy: { id: mongoose.Schema.Types.ObjectId, name: String },
    updatedBy: { id: mongoose.Schema.Types.ObjectId, name: String },
  },
  { timestamps: true, collection: "employees" }
);

employeeSchema.index({ nameKey: 1 });
employeeSchema.index({ status: 1, nameKey: 1 });
employeeSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: "objectId" } } });

module.exports = mongoose.model("Employee", employeeSchema);
