// تحقق نموذج إنشاء حساب الدخول في الواجهة (نفس قيود الحقول السابقة: الاسم مطلوب، اسم مستخدم 3–64 من A-Za-z0-9._@+-، كلمة مرور 10 خانات فأكثر).
// هو لتقديم رسالة أوضح قبل الإرسال فقط؛ الخادم هو المرجع في التحقق والصلاحيات.
export const USERNAME_RE = /^[A-Za-z0-9._@+-]{3,64}$/;
export function userCreateErrors({ name = "", username = "", password = "" }) {
  return {
    name: name.trim() ? "" : "الاسم مطلوب",
    username: !username.trim() ? "اسم المستخدم مطلوب" : USERNAME_RE.test(username.trim()) ? "" : "اسم المستخدم 3–64 خانة: حروف إنجليزية وأرقام و . _ @ + -",
    password: !password ? "كلمة المرور مطلوبة" : password.length < 10 ? "كلمة المرور 10 خانات على الأقل" : "",
  };
}
