const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
const env = require("../config/env");
const validate = require("../middleware/validate");
const { authenticate, csrfProtect } = require("../middleware/auth");
const v = require("../validations/auth.validation");
const controller = require("../controllers/auth.controller");

const tooMany = { message: "محاولات دخول كثيرة. حاول بعد 15 دقيقة.", code: "LOGIN_RATE_LIMITED" };
const common = { windowMs: 15 * 60_000, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message: tooMany };
// حدّان للمحاولات الفاشلة فقط: لكل (IP + حساب) ولكل IP بإجمالي أوسع (يمنع تدوير أسماء المستخدمين)
const perAccount = rateLimit({
  ...common, limit: env.loginMaxAttempts,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.identifier || "").trim().toLowerCase().slice(0, 64)}`,
});
const perIp = rateLimit({ ...common, limit: env.loginMaxAttempts * 4, keyGenerator: (req) => ipKeyGenerator(req.ip) });

// الدخول يتطلب JSON فقط (نموذج HTML عابر للمواقع لا يستطيع إرساله دون preflight مقيَّد بـ CORS)
const requireJson = (req, res, next) =>
  req.is("application/json") ? next() : res.status(415).json({ message: "نوع المحتوى غير مدعوم.", code: "UNSUPPORTED_MEDIA_TYPE", requestId: req.id });

router.post("/login", requireJson, perIp, perAccount, validate(v.login), controller.login);
router.get("/me", authenticate, validate(v.me), controller.me);
router.post("/logout", authenticate, csrfProtect, validate(v.logout), controller.logout);
router.post("/change-password", authenticate, csrfProtect, validate(v.changePassword), controller.changePassword);

module.exports = router;
