import { useState } from "react";
import { useAuth } from "../auth.jsx";

export default function Login() {
  const { login, notice } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return; // حماية من الإرسال المتكرر
    const next = {};
    if (!identifier.trim()) next.identifier = "أدخل اسم المستخدم.";
    if (!password) next.password = "أدخل كلمة المرور.";
    setErrors(next);
    setError("");
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await login(identifier.trim(), password);
    } catch (err) {
      setError(err.message);
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit} noValidate aria-busy={busy}>
        <div className="login-brand">Poplar.tr<small>إدارة المتجر والجرد</small></div>
        <h1>تسجيل الدخول</h1>

        {notice && !error && <div className="banner warn" role="status">{notice}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}

        <label>
          اسم المستخدم
          <input
            type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username" autoCapitalize="none" spellCheck="false" autoFocus dir="ltr"
            aria-invalid={Boolean(errors.identifier)} disabled={busy}
          />
          {errors.identifier && <span className="field-error">{errors.identifier}</span>}
        </label>

        <label>
          كلمة المرور
          <span className="password-field">
            <input
              type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password" dir="ltr" aria-invalid={Boolean(errors.password)} disabled={busy}
            />
            <button type="button" className="eye" onClick={() => setShow((v) => !v)} aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} aria-pressed={show} title={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {show
                  ? <><path d="M3 3l18 18" /><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a14 14 0 0 1-2.6 3.4M6.5 7.6C4.5 9 3.1 11 2.5 12c1 2 4.5 6 9.5 6 1.3 0 2.5-.3 3.6-.8" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>
                  : <><path d="M2.5 12C3.5 10 7 6 12 6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z" /><circle cx="12" cy="12" r="3" /></>}
              </svg>
            </button>
          </span>
          {errors.password && <span className="field-error">{errors.password}</span>}
        </label>

        <button className="btn primary big" disabled={busy}>
          {busy ? <><span className="spinner" aria-hidden="true" /> جارٍ التحقق...</> : "دخول"}
        </button>
        <p className="muted small-note">الحسابات يُنشئها مالك المتجر فقط. إن نسيت كلمة المرور فتواصل معه.</p>
      </form>
    </div>
  );
}
