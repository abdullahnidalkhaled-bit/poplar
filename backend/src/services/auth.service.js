const crypto = require("crypto");
const env = require("../config/env");
const userRepo = require("../repositories/user.repository");
const sessionRepo = require("../repositories/session.repository");
const { effectivePermissions } = require("../config/permissions");
const { verifyPassword, verifyDummy, hashPassword, passwordProblem } = require("../utils/password");
const { unauthorized, badRequest } = require("../utils/errors");

const TOUCH_EVERY_MS = 5 * 60_000;

// المعرّف الخام لا يُخزَّن: HMAC بسر الخادم، فتسريب مجموعة الجلسات وحده لا يكفي لانتحال جلسة
const hashSid = (token) => crypto.createHmac("sha256", env.sessionSecret).update(token).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const normalizeUsername = (v) => String(v || "").trim().toLowerCase();

// ما يُرسل للمتصفح عن المستخدم: لا هاش ولا tokenVersion
const publicUser = (u) => ({ id: String(u._id), name: u.name, username: u.username, role: u.role, active: u.active !== false, permissions: effectivePermissions(u) });

// جلسة جديدة دائماً (لا نعيد استعمال معرّف سابق: منع تثبيت الجلسة)
async function issueSession(user, meta = {}) {
  const token = randomToken();
  const csrf = randomToken(24);
  const now = Date.now();
  await sessionRepo.create({
    sidHash: hashSid(token), user: user._id, csrf, tokenVersion: user.tokenVersion || 0,
    createdAt: new Date(now), lastSeenAt: new Date(now), expiresAt: new Date(now + env.sessionAbsoluteDays * 86_400_000),
    ip: meta.ip, userAgent: String(meta.userAgent || "").slice(0, 200),
  });
  return { token, csrf, maxAgeMs: env.sessionAbsoluteDays * 86_400_000 };
}

const INVALID = () => unauthorized("اسم المستخدم أو كلمة المرور غير صحيحة.", "INVALID_CREDENTIALS");

async function login({ identifier, password }, meta, oldToken) {
  const user = await userRepo.findByUsername(normalizeUsername(identifier));
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
  // نفس الرد لحساب غير موجود/كلمة خاطئة/حساب معطّل: لا نكشف وجود الحسابات
  if (!user || !ok || user.active === false) throw INVALID();

  if (oldToken) await sessionRepo.deleteByHash(hashSid(oldToken)); // أي جلسة سابقة في المتصفح تُنهى
  await userRepo.update(user._id, { lastLoginAt: new Date() });
  const session = await issueSession(user, meta);
  return { ...session, user: publicUser(user) };
}

// يعيد { user, session } أو null. كل شيء يُتحقق منه على الخادم في كل طلب
async function resolveSession(token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const sidHash = hashSid(token);
  const s = await sessionRepo.findByHash(sidHash);
  if (!s) return null;
  const now = Date.now();
  const expired = new Date(s.expiresAt).getTime() <= now || now - new Date(s.lastSeenAt).getTime() > env.sessionIdleMinutes * 60_000;
  const user = expired ? null : await userRepo.findById(s.user);
  if (!user || user.active === false || (user.tokenVersion || 0) !== s.tokenVersion) {
    await sessionRepo.deleteByHash(sidHash);
    return null;
  }
  if (now - new Date(s.lastSeenAt).getTime() > TOUCH_EVERY_MS) await sessionRepo.touch(sidHash, new Date(now));
  return { user, session: { hash: sidHash, csrf: s.csrf } };
}

const logout = (token) => (token ? sessionRepo.deleteByHash(hashSid(token)) : undefined);

// تغيير كلمة المرور الذاتي: تسقط كل الجلسات الأخرى، وتبقى هذه بجلسة جديدة
async function changePassword(user, { currentPassword, newPassword }, meta, oldToken) {
  const fresh = await userRepo.findById(user._id);
  if (!(await verifyPassword(currentPassword, fresh.passwordHash))) throw unauthorized("كلمة المرور الحالية غير صحيحة.", "INVALID_CREDENTIALS");
  const problem = passwordProblem(newPassword, fresh.username);
  if (problem) throw badRequest(problem, "WEAK_PASSWORD");
  const updated = await userRepo.updateAndRevoke(fresh._id, { passwordHash: await hashPassword(newPassword) });
  await sessionRepo.deleteByUser(fresh._id);
  if (oldToken) await sessionRepo.deleteByHash(hashSid(oldToken));
  const session = await issueSession(updated, meta);
  return { ...session, user: publicUser(updated) };
}

module.exports = { login, resolveSession, logout, changePassword, issueSession, publicUser, normalizeUsername, hashSid };
