import { useState } from "react";
import { api } from "../../api.js";
import useSubmit from "../../hooks/useSubmit.js";
import Modal from "../ui/Modal.jsx";
import Field from "../ui/Field.jsx";
import { ErrorBanner } from "../ui/feedback.jsx";
import { newKey, money, todayStr, CUR } from "../../utils.js";
import ConfirmDialog from "../ui/ConfirmDialog.jsx";
import Actions from "../ui/FormActions.jsx";
import { validateAmount, openPeriods, ADJUST_KIND, EMP_STATUS } from "../../payrollUtils.js";

const iso = (d) => (d ? new Date(`${d}T12:00:00`).toISOString() : undefined);
const AmountField = ({ currency, value, onChange, error, label = "المبلغ", hint, autoFocus, required }) => (
  <Field label={`${label} (${CUR[currency]})`} required={required} error={error} hint={hint || (currency === "SYP" ? "عدد صحيح بالليرة" : "خانتان عشريتان كحد أقصى")}>
    <input type="number" min="0" step={currency === "SYP" ? "1" : "0.01"} value={value} onChange={onChange} dir="ltr" inputMode="decimal" autoFocus={autoFocus} aria-invalid={error ? "true" : undefined} />
  </Field>
);

// ───────────── موظف: إنشاء / تعديل ─────────────
export function EmployeeFormModal({ employee, onClose, onDone }) {
  const [f, setF] = useState({
    name: employee?.name || "", jobTitle: employee?.jobTitle || "", phone: employee?.phone || "", salary: employee ? String(employee.salary) : "", currency: employee?.currency || "USD",
    payDay: String(employee?.payDay || 1), status: employee?.status || "active", hireDate: employee?.hireDate ? employee.hireDate.slice(0, 10) : "", notes: employee?.notes || "",
  });
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const errs = { name: !f.name.trim() ? "الاسم مطلوب" : "", salary: f.salary === "" ? "الراتب مطلوب" : Number(f.salary) === 0 ? "" : validateAmount(f.currency, f.salary) };
  const bad = Object.values(errs).some(Boolean);
  const submit = (e) => {
    e.preventDefault();
    setShow(true);
    if (bad) return;
    const body = { name: f.name.trim(), jobTitle: f.jobTitle.trim(), phone: f.phone.trim(), salary: Number(f.salary), payDay: Number(f.payDay) || 1, status: f.status, notes: f.notes.trim(), hireDate: iso(f.hireDate) };
    run(() => (employee ? api.patch(`/employees/${employee.id}`, body) : api.post("/employees", { ...body, currency: f.currency })));
  };
  return (
    <Modal title={employee ? `تعديل ${employee.name}` : "موظف جديد"} onClose={onClose}>
      <form className="form" onSubmit={submit} noValidate>
        <ErrorBanner error={error} />
        <Field label="الاسم" required error={show && errs.name}><input value={f.name} onChange={set("name")} maxLength={120} autoFocus aria-invalid={show && errs.name ? "true" : undefined} /></Field>
        <div className="grid2">
          <Field label="المسمى الوظيفي"><input value={f.jobTitle} onChange={set("jobTitle")} maxLength={80} /></Field>
          <Field label="الهاتف"><input value={f.phone} onChange={set("phone")} maxLength={40} dir="ltr" inputMode="tel" /></Field>
        </div>
        <div className="grid2">
          <AmountField currency={f.currency} label="الراتب الشهري" required value={f.salary} onChange={set("salary")} error={show && errs.salary} />
          <Field label="العملة" hint={employee ? "لا تُغيَّر بعد إنشاء فترة رواتب أو سلفة" : undefined}>
            <select value={f.currency} onChange={set("currency")} disabled={!!employee}><option value="USD">دولار (USD)</option><option value="SYP">ليرة سورية (SYP)</option></select>
          </Field>
        </div>
        <div className="grid2">
          <Field label="يوم استحقاق الراتب من الشهر" hint="من 1 إلى 28"><input type="number" min="1" max="28" value={f.payDay} onChange={set("payDay")} dir="ltr" /></Field>
          <Field label="تاريخ التعيين"><input type="date" value={f.hireDate} onChange={set("hireDate")} /></Field>
        </div>
        {employee && <Field label="الحالة"><select value={f.status} onChange={set("status")}>{Object.entries(EMP_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
        <Field label="ملاحظات"><input value={f.notes} onChange={set("notes")} maxLength={500} /></Field>
        {employee && <p className="muted small-note">تغيير الراتب يسري على الفترات الجديدة فقط؛ الفترات القائمة تحتفظ بلقطة الراتب وقت إنشائها.</p>}
        <Actions onClose={onClose} busy={busy} label={employee ? "حفظ" : "إضافة"} />
      </form>
    </Modal>
  );
}

// ───────────── تسجيل سلفة من حساب الموظف: صرف في خطوة واحدة، وفترة الخصم تُعرض قبل التأكيد ─────────────
export function AdvanceIssueModal({ employee, summary, onClose, onDone }) {
  const [f, setF] = useState({ amount: "", method: "cash", note: "", date: todayStr(), periodKey: "" });
  const [changing, setChanging] = useState(false);
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone, newKey);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const err = validateAmount(employee.currency, f.amount);
  const period = f.periodKey || summary?.defaultAdvancePeriodKey;
  const reg = employee.currency === "SYP" ? "الليرة السورية" : "الدولار";
  const submit = () => run((k) => api.post("/employee-advances/issue", { employeeId: employee.id, amount: Number(f.amount), method: f.method, note: f.note.trim() || undefined, date: iso(f.date), ...(f.periodKey ? { deductionPeriodKey: f.periodKey } : {}), idempotencyKey: k }));
  return (
    <Modal title={`تسجيل سلفة · ${employee.name}`} onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); setShow(true); if (!err && period) setConfirm(true); }}>
        <ErrorBanner error={error} />
        <AmountField currency={employee.currency} value={f.amount} onChange={set("amount")} error={show && err} autoFocus />
        <Field label="طريقة الصرف">
          <select value={f.method} onChange={set("method")}>
            <option value="cash">من صندوق {reg} (نقداً)</option>
            <option value="other">من خارج الصندوق (دون حركة نقد)</option>
          </select>
        </Field>
        <div className="salary-card" aria-live="polite">
          <div><span className="muted">فترة الخصم</span><b>{period || "—"}</b></div>
          <div><span className="muted">سلف قائمة حالياً</span><b>{money(summary?.advances?.outstanding || 0, employee.currency)}</b></div>
        </div>
        {!changing
          ? <p className="muted small-note">تُخصم تلقائياً من أقرب شهر مفتوح (غير مغلق ولا مدفوع). {" "}<button type="button" className="btn small ghost" onClick={() => setChanging(true)}>تغيير الفترة</button></p>
          : <Field label="شهر الخصم" hint="أي شهر مفتوح؛ تُنشأ الفترة تلقائياً إن لم تكن موجودة."><input type="month" min={summary?.currentKey} value={f.periodKey || period || ""} onChange={set("periodKey")} /></Field>}
        <div className="grid2">
          <Field label="التاريخ"><input type="date" value={f.date} onChange={set("date")} max={todayStr()} /></Field>
          <Field label="ملاحظة"><input value={f.note} onChange={set("note")} maxLength={300} /></Field>
        </div>
        <p className="muted small-note">الصرف يُسجَّل مرة واحدة هنا. تُسوّى السلفة من الراتب تلقائياً عند دفعه، وما لا يتسع له الراتب يُرحَّل للشهر التالي.</p>
        <Actions onClose={onClose} busy={busy} label="مراجعة" />
      </form>
      {confirm && (
        <ConfirmDialog title="تأكيد صرف السلفة" confirmLabel="تأكيد الصرف" busy={busy}
          message={`سيُصرف ${money(Number(f.amount), employee.currency)} للموظف ${employee.name}${f.method === "cash" ? ` من صندوق ${reg} فقط` : " دون أي حركة في الصندوق"}، وتُخصم من راتب ${period}.`}
          onConfirm={async () => { await submit(); setConfirm(false); }} onCancel={() => setConfirm(false)} />
      )}
    </Modal>
  );
}

// ───────────── بدل / مكافأة / استقطاع: الفترة تُحلّ تلقائياً، وتُقفل بعد أول دفعة ─────────────
export function AdjustmentModal({ employee, periodKey, summary, onClose, onDone }) {
  const [f, setF] = useState({ kind: "allowance", amount: "", note: "", date: todayStr() });
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit(onDone, newKey);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const err = validateAmount(employee.currency, f.amount, f.kind === "deduction" && summary ? { max: summary.remainingBeforeSettlement } : {});
  return (
    <Modal title={`${ADJUST_KIND[f.kind]} · ${periodKey}`} onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); setShow(true); if (err || !f.note.trim()) return; run((k) => api.post(`/employees/${employee.id}/adjustments`, { kind: f.kind, amount: Number(f.amount), note: f.note.trim(), date: iso(f.date), periodKey, idempotencyKey: k })); }}>
        <ErrorBanner error={error} />
        <Field label="النوع"><select value={f.kind} onChange={set("kind")}>{Object.entries(ADJUST_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <AmountField currency={employee.currency} value={f.amount} onChange={set("amount")} error={show && err} autoFocus />
        <Field label="البيان" error={show && !f.note.trim() && "البيان مطلوب"}><input value={f.note} onChange={set("note")} maxLength={300} /></Field>
        <Field label="التاريخ"><input type="date" value={f.date} onChange={set("date")} /></Field>
        <p className="muted small-note">يُسمح بها قبل أول دفعة راتب أو تسوية سلفة لهذه الفترة فقط.</p>
        <Actions onClose={onClose} busy={busy} label="تسجيل" />
      </form>
    </Modal>
  );
}

// ───────────── إعادة إسناد فترة الخصم (إجراء صريح) ─────────────
export function ReassignModal({ advance, periods, onClose, onDone }) {
  const options = openPeriods(periods).filter((p) => p.id !== advance.deductionPeriodId);
  const [f, setF] = useState({ periodId: "", reason: "" });
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit(onDone, newKey);
  const errs = { periodId: f.periodId ? "" : "اختر الفترة الجديدة", reason: f.reason.trim() ? "" : "السبب مطلوب" };
  return (
    <Modal title={`نقل خصم السلفة ${advance.ref}`} onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); setShow(true); if (errs.periodId || errs.reason) return; run((k) => api.post(`/employee-advances/${advance.id}/reassign`, { periodId: f.periodId, reason: f.reason.trim(), idempotencyKey: k })); }}>
        <ErrorBanner error={error} />
        <p>الفترة الحالية: <b>{advance.deductionPeriodKey}</b>. يُسمح بالنقل قبل أي تسوية فقط، ويُسجَّل في الدفتر.</p>
        <Field label="الفترة الجديدة" error={show && errs.periodId}>
          <select value={f.periodId} onChange={(e) => setF({ ...f, periodId: e.target.value })}><option value="">— اختر —</option>{options.map((p) => <option key={p.id} value={p.id}>{p.periodKey}</option>)}</select>
        </Field>
        <Field label="السبب" error={show && errs.reason}><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={300} /></Field>
        <Actions onClose={onClose} busy={busy} label="نقل الخصم" />
      </form>
    </Modal>
  );
}

// ───────────── إجراء بسبب إلزامي (عكس / إلغاء) أو تأكيد بسيط ─────────────
export function ReasonModal({ title, message, confirmLabel, danger = true, path, body, onClose, onDone, withReason = true }) {
  const [reason, setReason] = useState("");
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); setShow(true); if (withReason && !reason.trim()) return; run(() => api.post(path, withReason ? { reason: reason.trim() } : body || {})); }}>
        <ErrorBanner error={error} />
        <p>{message}</p>
        {withReason && <Field label="السبب" error={show && !reason.trim() && "السبب مطلوب"}><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></Field>}
        <Actions onClose={onClose} busy={busy} label={confirmLabel} danger={danger} />
      </form>
    </Modal>
  );
}
