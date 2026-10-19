// خطأ تطبيقي "آمن للعرض": رسالته تصل للمستخدم كما هي
class AppError extends Error {
  constructor(status, message, code = "ERROR", details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  AppError,
  badRequest: (m, code = "BAD_REQUEST", d) => new AppError(400, m, code, d),
  unauthorized: (m = "يجب تسجيل الدخول.", code = "UNAUTHENTICATED") => new AppError(401, m, code),
  forbidden: (m = "ليست لديك صلاحية لهذا الإجراء.", code = "FORBIDDEN") => new AppError(403, m, code),
  notFound: (m, code = "NOT_FOUND") => new AppError(404, m, code),
  conflict: (m, code = "CONFLICT", d) => new AppError(409, m, code, d),
};
