require("dotenv").config();
const crypto = require("crypto");

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI,
  // أصول مسموح لها بالاتصال من متصفح آخر. فارغة = نفس الأصل فقط (الأكثر أماناً)
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  disableTransactions: process.env.DISABLE_TRANSACTIONS === "true",
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 600,
  // الجلسات: السر يُستعمل في HMAC لمعرّف الجلسة المخزَّن. مطلوب في الإنتاج؛ في التطوير/الاختبار يُولَّد سر مؤقت
  sessionSecret: process.env.SESSION_SECRET || "",
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES) || 480,
  sessionAbsoluteDays: Number(process.env.SESSION_ABSOLUTE_DAYS) || 7,
  // Secure افتراضياً في الإنتاج؛ COOKIE_SECURE=false لتجربة الإنتاج عبر http محلي
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
  // محاولات الدخول الفاشلة المسموحة لكل (IP + اسم مستخدم) خلال 15 دقيقة
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS) || 8,
};

// بلا سر مضبوط (تطوير/اختبار): سر عشوائي لهذه العملية فقط، فتنتهي الجلسات عند إعادة التشغيل
if (!env.sessionSecret) env.sessionSecret = crypto.randomBytes(32).toString("hex");
const secretWasProvided = Boolean(process.env.SESSION_SECRET);

// يُستدعى عند الإقلاع فقط (لا عند الاستيراد) حتى تعمل الاختبارات بلا .env
env.assertValid = () => {
  if (!env.mongoUri) {
    throw new Error("المتغير MONGO_URI مفقود. أنشئ ملف .env من .env.example");
  }
  if (env.nodeEnv === "production" && (!secretWasProvided || env.sessionSecret.length < 32)) {
    throw new Error("SESSION_SECRET مفقود أو أقصر من 32 حرفاً (مطلوب في الإنتاج). ولّده: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
  }
};

module.exports = Object.freeze(env);
