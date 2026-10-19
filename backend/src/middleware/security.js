const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const env = require("../config/env");

const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "blob:"],
      "connect-src": ["'self'"],
    },
  },
});

const limiter = rateLimit({
  windowMs: 60_000,
  limit: env.rateLimitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "طلبات كثيرة جداً. حاول بعد قليل.", code: "RATE_LIMITED" },
});

// عنوان محلي (أي منفذ): localhost أو 127.0.0.1 أو ::1 — يُسمح به دائماً حتى لو
// غيّر بروكسي أو VPN الشكل الذي يرى به المتصفح العنوان (منفذ مختلف، 127.0.0.1 بدل localhost...)
const LOCAL_HOSTNAME_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;
function isLocalOrigin(origin) {
  try {
    return LOCAL_HOSTNAME_RE.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// CORS مغلق افتراضياً (نفس الأصل)، مع السماح الدائم بأي عنوان محلي (localhost/127.0.0.1 بأي منفذ)
// وبالأصول الإضافية المحددة عبر CORS_ORIGINS فقط
const corsMiddleware = cors({
  credentials: true, // كوكي الجلسة HttpOnly يُرسل مع الأصول المسموحة فقط
  origin(origin, cb) {
    if (!origin || isLocalOrigin(origin) || env.corsOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error("غير مسموح بهذا الأصل (CORS)."));
  },
});

module.exports = { securityHeaders, limiter, corsMiddleware };
