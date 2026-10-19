const { z, label, str, objectId, idParam } = require("./common");
const { GRANTABLE } = require("../config/permissions");

// الدور غير موجود في أي مخطط عمداً (strict): إرساله يُرفض فلا تصعيد صلاحيات عبر الطلب
const username = z
  .string(label("اسم المستخدم"))
  .trim()
  .toLowerCase()
  .min(3, "اسم المستخدم قصير جداً")
  .max(64, "اسم المستخدم طويل جداً")
  .regex(/^[a-z0-9._@+-]+$/, "اسم المستخدم: أحرف إنجليزية صغيرة وأرقام و . _ - @ فقط");
const password = z.string(label("كلمة المرور")).min(1, "كلمة المرور مطلوبة").max(128, "كلمة المرور طويلة جداً");
const permissions = z.array(z.enum(GRANTABLE, { errorMap: () => ({ message: "صلاحية غير معروفة أو غير قابلة للمنح" }) })).max(40);

const list = {};
const create = { body: z.object({ name: str("الاسم", 80), username, password, permissions: permissions.optional() }).strict() };
const update = {
  params: idParam,
  body: z.object({ name: str("الاسم", 80).optional(), permissions: permissions.optional(), active: z.boolean().optional() }).strict(),
};
const resetPassword = { params: idParam, body: z.object({ password }).strict() };

module.exports = { list, create, update, resetPassword, objectId };
