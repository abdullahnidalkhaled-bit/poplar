import PageHeader from "../components/ui/PageHeader.jsx";
import { useState, useCallback } from "react";
import { api } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import Modal from "../components/ui/Modal.jsx";
import Field from "../components/ui/Field.jsx";
import FormActions from "../components/ui/FormActions.jsx";
import useSubmit from "../hooks/useSubmit.js";
import { userCreateErrors } from "../usersUtils.js";
import { Loading, ErrorBanner } from "../components/ui/feedback.jsx";
import { fmtDateTime } from "../utils.js";

// الصلاحيات القابلة للمنح للموظف (الخادم يرفض أي غيرها). صلاحيات المالك لا تظهر هنا أصلاً
const PERMS = [
  ["models.read", "عرض الموديلات والمسح"],
  ["stock.receive", "استلام الشحنات (بلا تكلفة)"],
  ["stock.transfer", "نقل بين المحل والمستودع"],
  ["stock.damage", "تسجيل التالف"],
  ["stock.adjust", "الجرد الفعلي (تعديل الكميات)"],
  ["series.read", "سجل الأرتال"],
  ["movements.read", "سجل الحركات"],
  ["invoices.create", "الكاشير (إنشاء فواتير)"],
  ["invoices.read", "عرض الفواتير"],
  ["invoices.cancel", "إلغاء الفواتير"],
  ["returns.create", "الإرجاع والتبديل"],
  ["returns.read", "عرض المرتجعات"],
  ["dashboard.view", "لوحة المخزون التشغيلية"],
  ["settings.read", "قراءة سعر الصرف"],
];
const DEFAULTS = ["models.read", "stock.receive", "stock.transfer", "stock.damage", "series.read", "movements.read", "invoices.read", "invoices.create", "returns.read", "returns.create", "dashboard.view", "settings.read"];

function PermissionPicker({ value, onChange }) {
  const toggle = (p) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  return (
    <fieldset className="perm-grid">
      <legend>الصلاحيات</legend>
      {PERMS.map(([p, label]) => (
        <label key={p} className="check"><input type="checkbox" checked={value.includes(p)} onChange={() => toggle(p)} /> {label}</label>
      ))}
    </fieldset>
  );
}

// إنشاء حساب دخول: نفس نمط نموذج الموظف (عرض النافذة، الترويسة، الحقول المطلوبة، رسائل الحقول، أزرار موحّدة، حارس الإرسال المزدوج)
function CreateModal({ onClose, onDone }) {
  const [f, setF] = useState({ name: "", username: "", password: "" });
  const [perms, setPerms] = useState(DEFAULTS);
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const errs = userCreateErrors(f);
  const bad = Object.values(errs).some(Boolean);
  const submit = (e) => {
    e.preventDefault();
    setShow(true);
    if (bad) return;
    run(() => api.post("/users", { ...f, username: f.username.trim().toLowerCase(), permissions: perms }));
  };
  const inv = (k) => (show && errs[k] ? "true" : undefined);
  return (
    <Modal title="حساب دخول جديد" onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        <ErrorBanner error={error} />
        <Field label="الاسم" required error={show && errs.name}><input value={f.name} onChange={set("name")} maxLength={80} autoFocus aria-invalid={inv("name")} /></Field>
        <Field label="اسم المستخدم (إنجليزي)" required error={show && errs.username}><input value={f.username} onChange={set("username")} dir="ltr" autoComplete="off" aria-invalid={inv("username")} /></Field>
        <Field label="كلمة المرور" required hint="10 خانات على الأقل، حروف وأرقام." error={show && errs.password}><input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" dir="ltr" aria-invalid={inv("password")} /></Field>
        <PermissionPicker value={perms} onChange={setPerms} />
        <FormActions onClose={onClose} busy={busy} label="إنشاء الحساب" />
      </form>
    </Modal>
  );
}

function EditModal({ user, onClose, onDone }) {
  const [name, setName] = useState(user.name);
  const [perms, setPerms] = useState(user.permissions);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    setError("");
    try { await fn(); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Modal title={`تعديل ${user.username}`} onClose={onClose} wide>
      <div className="form">
        <Field label="الاسم"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <PermissionPicker value={perms} onChange={setPerms} />
        <p className="muted small-note">حفظ التعديل يُنهي جلسات هذا الموظف الحالية فيسجّل الدخول من جديد.</p>
        <div className="actions">
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => run(() => api.patch(`/users/${user.id}`, { name: name.trim(), permissions: perms }))}>حفظ</button>
        </div>
        <hr />
        <Field label="كلمة مرور جديدة" hint="تُنهي كل جلسات الموظف وتفعّل الكلمة الجديدة.">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" dir="ltr" minLength={10} />
        </Field>
        <div className="actions">
          <button className="btn" disabled={busy || password.length < 10} onClick={() => run(() => api.post(`/users/${user.id}/reset-password`, { password }))}>إعادة ضبط كلمة المرور</button>
        </div>
        {error && <div className="banner error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

export default function Users() {
  const { data: users, error, loading, reload } = useAsync(() => api.get("/users"), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [actionError, setActionError] = useState(null);

  const toggle = useCallback(async (u) => {
    setActionError(null);
    try { await api.patch(`/users/${u.id}`, { active: !u.active }); reload(); } catch (e) { setActionError(e); }
  }, [reload]);

  return (
    <div>
      <PageHeader title="الموظفون" primary={<button className="btn primary" onClick={() => setCreating(true)}>حساب دخول جديد</button>} />
      <p className="muted small-note">حسابات المالك تُدار من الخادم فقط ولا تظهر هنا. الموظف لا يرى التكلفة ولا الأرباح ولا التقارير مهما كانت صلاحياته.</p>
      <ErrorBanner error={error || actionError} onRetry={reload} />
      {loading && !users ? <Loading /> : (
        <div className="table-wrap">
          <table className="table-cards">
            <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>الحالة</th><th>آخر دخول</th><th /></tr></thead>
            <tbody>
              {(users || []).map((u) => (
                <tr key={u.id} className={u.active ? "" : "cancelled"}>
                  <td data-label="الاسم">{u.name}</td>
                  <td data-label="اسم المستخدم" className="mono" dir="ltr">{u.username}</td>
                  <td data-label="الدور">{u.role === "admin" ? "مالك" : "موظف"}</td>
                  <td data-label="الحالة">{u.active ? <span className="pill">فعّال</span> : <span className="pill cancelled">معطّل</span>}</td>
                  <td data-label="آخر دخول" className="muted">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "—"}</td>
                  <td className="row-actions" data-label="">
                    {u.role === "employee" && <>
                      <button className="btn small" onClick={() => setEditing(u)}>تعديل</button>
                      <button className={`btn small ${u.active ? "danger" : ""}`} onClick={() => toggle(u)}>{u.active ? "تعطيل" : "تفعيل"}</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {editing && <EditModal user={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
