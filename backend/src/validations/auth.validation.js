const { z, label } = require("./common");

const login = {
  body: z
    .object({
      identifier: z.string(label("اسم المستخدم")).trim().min(1, "اسم المستخدم مطلوب").max(64, "اسم المستخدم طويل جداً"),
      password: z.string(label("كلمة المرور")).min(1, "كلمة المرور مطلوبة").max(128, "كلمة المرور طويلة جداً"),
    })
    .strict(),
};

const me = {};
const logout = {};

const changePassword = {
  body: z
    .object({
      currentPassword: z.string(label("كلمة المرور الحالية")).min(1, "كلمة المرور الحالية مطلوبة").max(128),
      newPassword: z.string(label("كلمة المرور الجديدة")).min(1, "كلمة المرور الجديدة مطلوبة").max(128),
    })
    .strict(),
};

module.exports = { login, me, logout, changePassword };
