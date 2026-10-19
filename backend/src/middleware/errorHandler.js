const { ZodError } = require("zod");
const { AppError } = require("../utils/errors");
const logger = require("../utils/logger");

const DUP_MESSAGES = {
  modelNumber: ["MODEL_NUMBER_TAKEN", "رقم الموديل مستخدم مسبقاً لموديل آخر."],
  "sizes.barcode": ["BARCODE_TAKEN", "هذا الباركود مستخدم مسبقاً."],
  idempotencyKey: ["SHIPMENT_DUPLICATE", "هذه الشحنة سُجّلت مسبقاً."],
  username: ["USERNAME_TAKEN", "اسم المستخدم مستخدم مسبقاً."],
  number: ["NUMBER_TAKEN", "تعارض في الترقيم، أعد المحاولة."],
};

const NETWORK = ["MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError"];

module.exports = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const send = (status, message, code, extra = {}) => res.status(status).json({ message, code, requestId: req.id, ...extra });

  if (err instanceof ZodError) {
    const errors = err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
    const first = errors[0];
    return send(400, `بيانات غير صالحة${first ? `: ${first.field ? first.field + " — " : ""}${first.message}` : ""}`, "VALIDATION_ERROR", { errors });
  }
  if (err instanceof AppError) return send(err.status, err.message, err.code, err.details ? { details: err.details } : {});
  if (err.name === "ValidationError" && err.errors) {
    const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return send(400, `بيانات غير صالحة: ${errors[0]?.message}`, "VALIDATION_ERROR", { errors });
  }
  if (err.name === "CastError") return send(400, "معرّف غير صالح.", "INVALID_ID");
  if (err.type === "entity.parse.failed") return send(400, "صيغة JSON غير صحيحة.", "INVALID_JSON");
  if (err.type === "entity.too.large") return send(413, "حجم الطلب كبير جداً.", "PAYLOAD_TOO_LARGE");
  if (err.code === 11000) {
    const key = Object.keys(err.keyPattern || {})[0];
    const [code, message] = DUP_MESSAGES[key] || ["DUPLICATE", "قيمة مكررة."];
    return send(409, message, code);
  }
  if (NETWORK.includes(err.name) || /buffering timed out/i.test(err.message || "")) {
    logger.error({ err, id: req.id }, "database unavailable");
    return send(503, "قاعدة البيانات غير متاحة حالياً. تأكد من الاتصال وحاول مجدداً.", "DB_UNAVAILABLE");
  }

  // خطأ غير متوقع: التفاصيل في السجل فقط، والمستخدم يرى رسالة عامة مع معرّف للتتبع
  logger.error({ err, id: req.id, path: req.path }, "unhandled error");
  return send(500, "حدث خطأ غير متوقع في الخادم.", "INTERNAL_ERROR");
};
