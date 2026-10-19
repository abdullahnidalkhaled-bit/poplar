import { useEffect, useState } from "react";
import { api, qs } from "../../api.js";
import useAsync from "../../hooks/useAsync.js";
import useSubmit from "../../hooks/useSubmit.js";
import Modal from "../ui/Modal.jsx";
import ConfirmDialog from "../ui/ConfirmDialog.jsx";
import Field from "../ui/Field.jsx";
import { ErrorBanner, Loading } from "../ui/feedback.jsx";
import { money, newKey, todayStr, CUR_NAME } from "../../utils.js";
import { SALARY_CATEGORY, salaryFormState } from "../../payrollUtils.js";

const CATEGORIES = ["إيجار", "كهرباء وماء", "مواصلات", "تغليف", "صيانة", SALARY_CATEGORY];
const OTHER = "__other";

/**
 * نموذج المصروف الموحّد (المالية ← المصروفات، وزر «دفع الراتب» في حساب الموظف): الحقول تتبدّل بحسب الفئة.
 *  - فئة عادية: كما كان (صندوق العملة + المبلغ + الفئة + الوصف).
 *  - فئة «رواتب»: يظهر اختيار الموظف، ويجلب النموذج ملخص الراتب الموثوق من الخادم (الاستحقاق، المدفوع، تسوية السلف، المتبقي)
 *    ويملأ المبلغ بالمتبقي للدفع. لا يُدخل المستخدم أي رصيد، ويُعاد حساب كل شيء على الخادم قبل الحفظ.
 * preset: { employeeId } يثبّت فئة الرواتب والموظف (من حساب الموظف).
 */
export default function ExpenseFormModal({ onClose, onDone, preset }) {
  const [cat, setCat] = useState(preset?.employeeId ? SALARY_CATEGORY : "");
  const [custom, setCustom] = useState("");
  const [f, setF] = useState({ currency: "SYP", amount: "", description: "", date: todayStr(), method: "cash", employeeId: preset?.employeeId || "", periodKey: "" });
  const [confirm, setConfirm] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const isSalary = cat === SALARY_CATEGORY;
  const category = cat === OTHER ? custom.trim() : cat;

  const employees = useAsync(() => (isSalary && !preset?.employeeId ? api.get(`/employees${qs({ status: "active", limit: 100 })}`) : Promise.resolve(null)), [isSalary]);
  const summary = useAsync(() => (isSalary && f.employeeId ? api.get(`/employees/${f.employeeId}/payroll-summary${qs({ period: f.periodKey })}`) : Promise.resolve(null)), [isSalary, f.employeeId, f.periodKey]);
  const sm = isSalary ? summary.data : null;

  // المبلغ الافتراضي = المتبقي للدفع كما يحسبه الخادم (يُحدَّث عند تغيير الموظف أو الفترة)
  useEffect(() => {
    if (sm) setF((p) => ({ ...p, amount: sm.canPay ? String(sm.remainingPayable) : "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm?.employee?.id, sm?.periodKey, sm?.remainingPayable]);

  const state = isSalary ? salaryFormState(sm, f.amount) : null;
  const currency = isSalary ? sm?.currency : f.currency;
  const ordinaryOk = !isSalary && Number(f.amount) > 0 && category;
  const canReview = isSalary ? state?.ready : ordinaryOk;

  const { busy, error, run } = useSubmit(onDone, newKey);
  const submit = () => run((k) => api.post("/finance/expenses", {
    currency, amount: Number(f.amount), category, description: f.description.trim() || undefined, date: new Date(`${f.date}T12:00:00`).toISOString(), idempotencyKey: k,
    ...(isSalary ? { employeeId: f.employeeId, method: f.method, ...(f.periodKey ? { periodKey: f.periodKey } : {}) } : {}),
  }));
  const reg = CUR_NAME[currency] || "";

  return (
    <Modal title={isSalary ? "دفع راتب" : "مصروف جديد"} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (canReview) setConfirm(true); }} noValidate>
        {!preset && (
          <Field label="الفئة">
            <select value={cat} onChange={(e) => { setCat(e.target.value); setF({ ...f, employeeId: "", amount: "", periodKey: "" }); }} required>
              <option value="">— اختر الفئة —</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value={OTHER}>أخرى…</option>
            </select>
          </Field>
        )}
        {cat === OTHER && <Field label="اسم الفئة"><input value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={60} required autoFocus /></Field>}

        {isSalary ? (
          <>
            {!preset?.employeeId && (
              <Field label="الموظف">
                <select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value, amount: "", periodKey: "" })} required>
                  <option value="">— اختر الموظف —</option>
                  {(employees.data?.items || []).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.number}</option>)}
                </select>
              </Field>
            )}
            {employees.loading && !employees.data && !preset?.employeeId && <Loading />}
            {f.employeeId && (summary.loading && !sm ? <Loading label="جارٍ حساب المستحق..." /> : summary.error ? <ErrorBanner error={summary.error} onRetry={summary.reload} /> : sm && (
              <>
                <div className="salary-card" aria-live="polite">
                  <div><span className="muted">فترة الراتب</span><b>{sm.periodKey}</b></div>
                  <div><span className="muted">صافي الراتب المستحق</span><b>{money(sm.entitlement, sm.currency)}</b></div>
                  <div><span className="muted">مدفوع سابقاً</span><b>{money(sm.paid, sm.currency)}</b></div>
                  <div><span className="muted">تسوية سلف</span><b>{money(sm.settlementsApplied + sm.scheduledSettlement, sm.currency)}</b></div>
                  <div className="due"><span className="muted">المتبقي للدفع</span><b>{money(sm.remainingPayable, sm.currency)}</b></div>
                </div>
                {sm.scheduledSettlement > 0 && <p className="muted small-note">سيُخصم <b>{money(sm.scheduledSettlement, sm.currency)}</b> من السلف المجدولة لهذه الفترة عند تسجيل الدفعة{sm.carryForward > 0 ? ` ويُرحَّل ${money(sm.carryForward, sm.currency)} إلى الشهر التالي` : ""}.</p>}
                {state?.blocked && <div className="banner warn" role="status"><span>{state.blocked}</span></div>}
                <Field label="الشهر" hint="يُحدَّد تلقائياً (أقدم شهر عليه متبقٍ)؛ غيّره لدفع شهر آخر.">
                  <input type="month" value={f.periodKey || sm.periodKey} max={sm.currentKey} onChange={(e) => setF({ ...f, periodKey: e.target.value })} aria-label="شهر الراتب" />
                </Field>
              </>
            ))}
            {sm && (
              <>
                <div className="grid2">
                  <Field label={`المبلغ (${sm.currency === "SYP" ? "ل.س" : "$"})`} error={f.amount !== "" && state?.error} hint={state?.partial ? "دفعة جزئية: يبقى الباقي مستحقاً." : state?.full ? "تسديد كامل للمتبقي." : "الافتراضي = المتبقي للدفع؛ يمكنك تخفيضه لدفعة جزئية."}>
                    <input type="number" min="0" step={sm.currency === "SYP" ? "1" : "0.01"} value={f.amount} onChange={set("amount")} dir="ltr" inputMode="decimal" disabled={!sm.canPay} aria-invalid={state?.error ? "true" : undefined} />
                  </Field>
                  <Field label="التاريخ"><input type="date" value={f.date} onChange={set("date")} max={todayStr()} /></Field>
                </div>
                <Field label="طريقة الدفع">
                  <select value={f.method} onChange={set("method")}>
                    <option value="cash">من صندوق {sm.currency === "SYP" ? "الليرة" : "الدولار"} (نقداً)</option>
                    <option value="other">من خارج الصندوق (تحويل مثلاً)</option>
                  </select>
                </Field>
              </>
            )}
          </>
        ) : cat && cat !== "" ? (
          <>
            <p className="muted small-note">يُدفع نقداً من صندوق العملة المختارة فقط، ويُحسب مصروفاً تشغيلياً في قسم تلك العملة.</p>
            <div className="grid3">
              <Field label="الصندوق"><select value={f.currency} onChange={set("currency")}><option value="SYP">الليرة السورية</option><option value="USD">الدولار الأمريكي</option></select></Field>
              <Field label={`المبلغ (${f.currency === "USD" ? "$" : "ل.س"})`}><input type="number" min="0" step={f.currency === "SYP" ? "1" : "0.01"} value={f.amount} onChange={set("amount")} required dir="ltr" /></Field>
              <Field label="التاريخ"><input type="date" value={f.date} onChange={set("date")} max={todayStr()} /></Field>
            </div>
          </>
        ) : null}
        {cat && <Field label="وصف (اختياري)"><input value={f.description} onChange={set("description")} maxLength={300} /></Field>}
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn primary" disabled={busy || !canReview}>مراجعة</button>
        </div>
      </form>
      {confirm && (
        <ConfirmDialog
          title={isSalary ? "تأكيد دفع الراتب" : "تأكيد المصروف"} confirmLabel={isSalary ? "تسجيل الدفعة" : "تسجيل المصروف"} busy={busy}
          message={isSalary
            ? `سيُسجَّل مصروف رواتب بقيمة ${money(Number(f.amount), currency)} للموظف ${sm?.employee?.name} عن ${sm?.periodKey}${f.method === "cash" ? ` ويُخصم من صندوق ${reg} فقط` : " دون أي حركة في الصندوق"}.${sm?.scheduledSettlement > 0 ? ` وتُخصم السلف المجدولة (${money(sm.scheduledSettlement, sm.currency)}) من الراتب.` : ""}`
            : `سيُخصم ${money(Number(f.amount), currency)} من صندوق ${reg} فقط ويُسجَّل مصروفاً تشغيلياً. لا يمكن تعديله لاحقاً، ويُصحَّح بعكسه.`}
          onConfirm={async () => { await submit(); setConfirm(false); }} onCancel={() => setConfirm(false)} />
      )}
    </Modal>
  );
}
