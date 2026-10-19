const crypto = require("crypto");
const env = require("../config/env");
const authService = require("../services/auth.service");
const { effectivePermissions } = require("../config/permissions");
const { unauthorized, forbidden } = require("../utils/errors");

const COOKIE = "poplar_sid";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// قراءة الكوكي يدوياً (لا نعتمد على حزمة تحليل كوكي خارجية)
function readToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// HttpOnly (لا يصل إليه JavaScript)، SameSite=Strict، Secure في الإنتاج، ومحصور بمسار /api
const cookieBase = () => ({ httpOnly: true, sameSite: "strict", secure: env.cookieSecure, path: "/api" });
const setSessionCookie = (res, token, maxAge) => res.cookie(COOKIE, token, { ...cookieBase(), maxAge });
const clearSessionCookie = (res) => res.clearCookie(COOKIE, cookieBase());

// يحدّد المستخدم من حالة الخادم فقط. أي شيء يرسله المتصفح عن الدور يُتجاهل
async function authenticate(req, res, next) {
  try {
    const token = readToken(req);
    const resolved = token ? await authService.resolveSession(token) : null;
    if (!resolved) {
      if (token) clearSessionCookie(res);
      throw unauthorized("انتهت الجلسة أو لم تسجّل الدخول. سجّل الدخول من جديد.", "UNAUTHENTICATED");
    }
    const { user, session } = resolved;
    req.user = { id: String(user._id), name: user.name, username: user.username, role: user.role, permissions: new Set(effectivePermissions(user)) };
    req.session = session;
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

// حماية CSRF: الكوكي SameSite=Strict + رمز مرتبط بالجلسة يُرسل بترويسة مخصصة على كل طلب تعديل
function csrfProtect(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const given = Buffer.from(String(req.get("x-csrf-token") || ""));
  const expected = Buffer.from(String(req.session?.csrf || ""));
  if (!expected.length || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return next(forbidden("رمز الحماية (CSRF) مفقود أو غير صحيح. حدّث الصفحة.", "CSRF_INVALID"));
  }
  next();
}

// يكفي امتلاك واحدة من الصلاحيات المذكورة. الأدمن يملك الكل عبر effectivePermissions
const requirePermission = (...perms) => (req, res, next) => {
  if (!req.user) return next(unauthorized());
  if (perms.some((p) => req.user.permissions.has(p))) return next();
  next(forbidden());
};

// حقول إدخال لا يجوز لغير صاحب الصلاحية إرسالها أصلاً (مثل unitCostUsd): نرفضها صراحةً لا نتجاهلها بصمت
const forbidFieldsWithout = (perm, fields, message = "لا يمكنك إدخال بيانات التكلفة.") => (req, res, next) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!req.user?.permissions.has(perm) && fields.some((f) => f in body)) return next(forbidden(message, "FORBIDDEN_FIELD"));
  next();
};

module.exports = { COOKIE, readToken, setSessionCookie, clearSessionCookie, authenticate, csrfProtect, requirePermission, forbidFieldsWithout };
