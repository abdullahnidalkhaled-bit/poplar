const service = require("../services/auth.service");
const { readToken, setSessionCookie, clearSessionCookie } = require("../middleware/auth");

const meta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });
// رمز CSRF يُسلَّم في الاستجابة (لا في كوكي يقرؤه JS)؛ تحتفظ به الواجهة في الذاكرة فقط
const payload = (r) => ({ user: r.user, csrfToken: r.csrf });

module.exports = {
  login: async (req, res) => {
    const r = await service.login(req.valid.body, meta(req), readToken(req));
    setSessionCookie(res, r.token, r.maxAgeMs);
    res.success(payload(r));
  },
  logout: async (req, res) => {
    await service.logout(req.sessionToken);
    clearSessionCookie(res);
    res.success({ ok: true });
  },
  me: async (req, res) => res.success({ user: { id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role, permissions: [...req.user.permissions] }, csrfToken: req.session.csrf }),
  changePassword: async (req, res) => {
    const r = await service.changePassword({ _id: req.user.id }, req.valid.body, meta(req), req.sessionToken);
    setSessionCookie(res, r.token, r.maxAgeMs);
    res.success(payload(r));
  },
};
