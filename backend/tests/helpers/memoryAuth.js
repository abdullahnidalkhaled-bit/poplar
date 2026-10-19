// أدوات اختبار HTTP بلا قاعدة بيانات: مستودعا المستخدمين والجلسات يُستبدلان بنسخ في الذاكرة
// (الخدمات والبرمجيات الوسيطة الحقيقية هي التي تُختبر؛ فقط طبقة التخزين تُحاكى).
const crypto = require("node:crypto");
const userRepo = require("../../src/repositories/user.repository");
const sessionRepo = require("../../src/repositories/session.repository");
const { hashPassword } = require("../../src/utils/password");

const PASSWORD = "Str0ng-Test-Pass1";
let users, sessions, hashed;
const id = () => crypto.randomBytes(12).toString("hex");
const clone = (o) => (o ? JSON.parse(JSON.stringify(o), (k, v) => (k.endsWith("At") && typeof v === "string" ? new Date(v) : v)) : o);

function install() {
  users = new Map();
  sessions = new Map();
  Object.assign(userRepo, {
    findById: async (i) => clone(users.get(String(i))) || null,
    findByUsername: async (u) => clone([...users.values()].find((x) => x.username === u)) || null,
    list: async () => [...users.values()].map(clone),
    create: async (d) => { const u = { _id: id(), tokenVersion: 0, createdAt: new Date(), ...d }; users.set(u._id, u); return clone(u); },
    countAdmins: async () => [...users.values()].filter((u) => u.role === "admin").length,
    update: async (i, p) => { const u = users.get(String(i)); Object.assign(u, p); return clone(u); },
    updateAndRevoke: async (i, p) => { const u = users.get(String(i)); Object.assign(u, p); u.tokenVersion += 1; return clone(u); },
  });
  Object.assign(sessionRepo, {
    create: async (d) => { sessions.set(d.sidHash, { ...d }); },
    findByHash: async (h) => clone(sessions.get(h)) || null,
    deleteByHash: async (h) => { sessions.delete(h); },
    deleteByUser: async (u) => { for (const [h, s] of sessions) if (String(s.user) === String(u)) sessions.delete(h); },
    deleteOthersOfUser: async (u, keep) => { for (const [h, s] of sessions) if (String(s.user) === String(u) && h !== keep) sessions.delete(h); },
    touch: async (h, at) => { const s = sessions.get(h); if (s) s.lastSeenAt = at; },
  });
  return { users, sessions };
}

async function createUser({ username, role = "employee", permissions, active = true, name = "اختبار", password = PASSWORD }) {
  hashed = hashed || (await hashPassword(PASSWORD));
  const passwordHash = password === PASSWORD ? hashed : await hashPassword(password);
  return userRepo.create({ name, username, passwordHash, role, permissions, active });
}

const parseSetCookie = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("poplar_sid=")) || "";

async function rawCall(base, method, path, { body, headers = {}, session, raw } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (session) { h.Cookie = session.cookie; h["x-csrf-token"] = session.csrf; }
  const res = await fetch(base + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
}

async function login(base, username, password = PASSWORD) {
  const res = await rawCall(base, "POST", "/auth/login", { body: { identifier: username, password } });
  return { res, session: res.status === 200 ? { cookie: parseSetCookie(res), csrf: res.json.csrfToken } : null };
}

module.exports = { install, createUser, rawCall, login, parseSetCookie, PASSWORD, stores: () => ({ users, sessions }) };
