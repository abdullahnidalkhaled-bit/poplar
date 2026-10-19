import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setCsrfToken, setUnauthorizedHandler } from "./api.js";

// حالة المصادقة المركزية. الواجهة تُخفي وتُوجّه فقط للراحة؛ الحماية الفعلية على الخادم.
// لا نخزّن شيئاً في localStorage: الجلسة كوكي HttpOnly يديره المتصفح، ورمز CSRF في الذاكرة.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [status, setStatus] = useState("loading"); // loading | anon | authed
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState("");

  const apply = useCallback((data) => {
    setCsrfToken(data.csrfToken);
    setUser(data.user);
    setStatus("authed");
  }, []);

  const reset = useCallback((message = "") => {
    setCsrfToken("");
    setUser(null);
    setStatus("anon");
    setNotice(message);
  }, []);

  // استعادة الجلسة بعد تحديث الصفحة
  useEffect(() => {
    api.getAnon("/auth/me").then(apply).catch(() => reset());
  }, [apply, reset]);

  // أي 401 من الخادم أثناء الاستعمال = انتهت الجلسة أو أُسقطت
  useEffect(() => {
    setUnauthorizedHandler((message) => reset(message || "انتهت الجلسة. سجّل الدخول من جديد."));
    return () => setUnauthorizedHandler(null);
  }, [reset]);

  const login = useCallback(async (identifier, password) => {
    apply(await api.postAnon("/auth/login", { identifier, password }));
    setNotice("");
  }, [apply]);

  const logout = useCallback(async () => {
    try { await api.post("/auth/logout"); } catch { /* نخرج محلياً في كل الأحوال */ }
    reset();
  }, [reset]);

  const value = useMemo(() => {
    const perms = new Set(user?.permissions || []);
    return { status, user, notice, login, logout, can: (p) => perms.has(p), canAny: (...ps) => ps.some((p) => perms.has(p)), isAdmin: user?.role === "admin" };
  }, [status, user, notice, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
