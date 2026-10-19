const userRepo = require("../repositories/user.repository");
const sessionRepo = require("../repositories/session.repository");
const { EMPLOYEE_DEFAULTS, GRANTABLE } = require("../config/permissions");
const { hashPassword, passwordProblem } = require("../utils/password");
const { publicUser, normalizeUsername } = require("./auth.service");
const { badRequest, notFound, forbidden } = require("../utils/errors");

const present = (u) => ({ ...publicUser(u), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null });
const onlyGrantable = (list) => [...new Set(list)].filter((p) => GRANTABLE.includes(p));

async function targetEmployee(id) {
  const u = await userRepo.findById(id);
  if (!u) throw notFound("الحساب غير موجود.", "USER_NOT_FOUND");
  // حسابات المالك لا تُعدَّل عبر الـ API إطلاقاً (تُدار بسكربت الخادم فقط)
  if (u.role !== "employee") throw forbidden("لا يمكن تعديل حساب المالك من هنا.", "ADMIN_ACCOUNT_PROTECTED");
  return u;
}

async function list() {
  return (await userRepo.list()).map(present);
}

// الدور يُفرض هنا دائماً (employee): لا يوجد مسار API ينشئ مالكاً
async function create({ name, username, password, permissions }) {
  const uname = normalizeUsername(username);
  const problem = passwordProblem(password, uname);
  if (problem) throw badRequest(problem, "WEAK_PASSWORD");
  const user = await userRepo.create({
    name, username: uname, passwordHash: await hashPassword(password), role: "employee",
    permissions: permissions ? onlyGrantable(permissions) : [...EMPLOYEE_DEFAULTS], active: true,
  });
  return present(user);
}

async function update(id, { name, permissions, active }) {
  const u = await targetEmployee(id);
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (permissions !== undefined) patch.permissions = onlyGrantable(permissions);
  if (active !== undefined) patch.active = active;
  if (!Object.keys(patch).length) return present(u);
  // تغيير الصلاحيات أو الحالة يُسقط الجلسات القائمة فوراً
  const sensitive = permissions !== undefined || (active !== undefined && active !== u.active);
  const updated = sensitive ? await userRepo.updateAndRevoke(u._id, patch) : await userRepo.update(u._id, patch);
  if (sensitive) await sessionRepo.deleteByUser(u._id);
  return present(updated);
}

async function resetPassword(id, password) {
  const u = await targetEmployee(id);
  const problem = passwordProblem(password, u.username);
  if (problem) throw badRequest(problem, "WEAK_PASSWORD");
  await userRepo.updateAndRevoke(u._id, { passwordHash: await hashPassword(password) });
  await sessionRepo.deleteByUser(u._id);
  return { ok: true };
}

module.exports = { list, create, update, resetPassword };
