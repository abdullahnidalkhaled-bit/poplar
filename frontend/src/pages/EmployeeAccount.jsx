import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, qs } from "../api.js";
import { useAuth } from "../auth.jsx";
import useAsync from "../hooks/useAsync.js";
import PageHeader from "../components/ui/PageHeader.jsx";
import StatCard from "../components/ui/StatCard.jsx";
import Pagination from "../components/ui/Pagination.jsx";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import { Loading, ErrorBanner, EmptyState, Alert } from "../components/ui/feedback.jsx";
import ExpenseFormModal from "../components/finance/ExpenseFormModal.jsx";
import { EmployeeFormModal, AdvanceIssueModal, AdjustmentModal, ReassignModal, ReasonModal } from "../components/payroll/PayrollForms.jsx";
import { money, fmtDateTime } from "../utils.js";
import { EMP_STATUS, PERIOD_STATUS, ADVANCE_STATUS, LEDGER_TYPE, LEDGER_STATE, PAY_BLOCK, isPeriodKey } from "../payrollUtils.js";

const TABS = [["overview", "الملخص"], ["statement", "كشف الحساب"]];

// حساب الموظف المالي: كل الأرقام من ملخص الخادم (payroll-summary). إجراءان رئيسيان: دفع الراتب وتسجيل سلفة؛ وكشف الحساب الكامل له مدخل واحد هو تبويب «كشف الحساب».
// دفع الراتب هو نفسه نموذج المالية ← المصروفات (فئة رواتب) فلا يوجد منطق دفع مكرر.
export default function EmployeeAccount() {
  const { id } = useParams();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const periodParam = sp.get("period") || "";
  const [tab, setTab] = useState("overview");
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState("");
  const [lf, setLf] = useState({ type: "", state: "", scope: "period", from: "", to: "", page: 1 });

  const sum = useAsync(() => api.get(`/employees/${id}/payroll-summary${qs({ period: periodParam })}`), [id, periodParam]);
  const s = sum.data;
  const ledger = useAsync(
    () => (s ? api.get(`/employees/${id}/ledger${qs({ type: lf.type, state: lf.state, periodKey: lf.scope === "period" ? s.periodKey : "", from: lf.from && new Date(`${lf.from}T00:00:00`).toISOString(), to: lf.to && new Date(`${lf.to}T23:59:59`).toISOString(), page: lf.page, limit: 20 })}`) : Promise.resolve(null)),
    [id, s?.periodKey, s?.paid, s?.settlementsApplied, s?.advances?.outstanding, s?.entitlement, lf.type, lf.state, lf.scope, lf.from, lf.to, lf.page]
  );
  const refresh = () => { sum.reload(); ledger.reload(); };
  const done = (msg) => (out) => { setModal(null); setNotice(out?.duplicate ? "هذه العملية سُجّلت مسبقاً." : msg); refresh(); };
  const close = () => setModal(null);
  const setPeriod = (k) => setSp(k && k !== sum.data?.currentKey ? { period: k } : {}, { replace: true });

  if (sum.loading && !s) return <Loading />;
  if (sum.error) return <div><ErrorBanner error={sum.error} onRetry={sum.reload} /></div>;
  const e = s.employee;
  const cur = s.currency;
  const m = (v) => money(v, cur);
  const refOf = Object.fromEntries((ledger.data?.items || []).map((l) => [l.id, l.ref]));
  const canPayNow = s.canPay && can("payroll.pay") && can("finance.manage");

  const rowAction = (l) => {
    if (l.state !== "posted") return null;
    const p = s.periods.find((x) => x.id === l.periodId);
    if (p?.status === "closed") return null;
    if (l.type === "salary_payment" && l.expenseId && can("finance.manage")) return <button className="btn small ghost" onClick={() => setModal({ kind: "rev-pay", entry: l })}>عكس</button>;
    if (l.type === "advance_settlement" && can("advances.reverse")) return <button className="btn small ghost" onClick={() => setModal({ kind: "rev-settle", entry: l })}>عكس</button>;
    if (["allowance", "bonus", "deduction"].includes(l.type) && can("payroll.manage")) return <button className="btn small ghost" onClick={() => setModal({ kind: "rev-adjust", entry: l })}>عكس</button>;
    return null;
  };

  const more = [
    { label: "بدل / مكافأة / استقطاع", onClick: () => setModal({ kind: "adjust" }), hidden: !can("payroll.manage") || s.closed || e.status !== "active" },
    { label: "تطبيق خصم السلف المجدولة الآن", onClick: () => setModal({ kind: "settle" }), hidden: !can("advances.manage") || !s.periodExists || s.closed || !(s.scheduledSettlement > 0) },
    { label: "إغلاق فترة الشهر", onClick: () => setModal({ kind: "close" }), hidden: !can("payroll.approve") || !s.periodExists || s.closed },
    { label: "تعديل بيانات الموظف", onClick: () => setModal({ kind: "edit" }), hidden: !can("employees.manage") },
  ];

  return (
    <div>
      <PageHeader
        crumbs={[{ to: "/employees", label: "الموظفون" }, { label: e.name }]}
        title={<>{e.name} {e.status !== "active" && <span className="pill cancelled">{EMP_STATUS[e.status]}</span>}</>}
        sub={<span><span className="mono">{e.number}</span>{e.jobTitle ? ` · ${e.jobTitle}` : ""} · الراتب الشهري {m(e.salary)} · يُستحق يوم {e.payDay}{e.phone ? ` · ${e.phone}` : ""}</span>}
        more={more}
      />
      {notice && <div className="banner ok" role="status"><span>{notice}</span><button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button></div>}

      <div className="account-actions">
        <button className="btn primary" disabled={!canPayNow} title={!s.canPay ? PAY_BLOCK[s.reason] : undefined} onClick={() => setModal({ kind: "pay" })}>دفع الراتب</button>
        {can("advances.manage") && <button className="btn" disabled={e.status !== "active"} onClick={() => setModal({ kind: "advance" })}>تسجيل سلفة</button>}
      </div>
      {!s.canPay && <p className="muted small-note" role="status">{PAY_BLOCK[s.reason]}</p>}

      <div className="period-bar">
        <label className="inline-field">الشهر
          <input type="month" value={isPeriodKey(s.periodKey) ? s.periodKey : ""} onChange={(ev) => ev.target.value && setPeriod(ev.target.value)} aria-label="شهر الراتب" />
        </label>
        {s.periodKey !== s.currentKey && <button className="btn small ghost" onClick={() => setPeriod("")}>الشهر الحالي</button>}
        <span className="pill">{s.status ? PERIOD_STATUS[s.status] : "لم تُنشأ فترة بعد"}</span>
      </div>

      <div className="seg sup-tabs" role="tablist" aria-label="أقسام حساب الموظف">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === "overview" && (
        <>
          {s.closed && <Alert tone="info" title="فترة مغلقة">هذه الفترة لا تقبل تعديلاً عادياً.</Alert>}
          {s.carryForward > 0 && <Alert tone="warn" title="ترحيل سلفة">لا يتسع راتب هذا الشهر لكامل السلف المجدولة: سيُخصم {m(s.scheduledSettlement)} ويُرحَّل {m(s.carryForward)} إلى الشهر التالي.</Alert>}

          <h3 className="section-title">الراتب · {s.periodKey}</h3>
          <div className="stats">
            <StatCard label="صافي الراتب المستحق" value={m(s.entitlement)} hint={`أساسي ${m(s.baseSalary)}${s.allowances + s.bonuses > 0 ? ` + ${m(s.allowances + s.bonuses)}` : ""}${s.deductions > 0 ? ` − ${m(s.deductions)}` : ""}`} />
            <StatCard label="المدفوع في الفترة" value={m(s.paid)} tone="good" />
            <StatCard label="المتبقي للدفع" value={m(s.remainingPayable)} tone={s.remainingPayable > 0 ? "loss" : "good"} hint={s.scheduledSettlement > 0 ? `بعد خصم سلف ${m(s.scheduledSettlement)}` : undefined} />
          </div>

          <h3 className="section-title">السلف</h3>
          <div className="stats">
            <StatCard label="سلف قائمة (كل الفترات)" value={m(s.advances.outstanding)} hint={s.advances.pending > 0 ? `+ ${m(s.advances.pending)} غير مصروفة` : "مصروفة وغير مسوّاة"} />
            <StatCard label="مجدولة للخصم في هذه الفترة" value={m(s.advances.scheduledInPeriod)} />
            <StatCard label="مسوّاة في هذه الفترة" value={m(s.advances.settledInPeriod)} />
          </div>
          <p className="muted small-note">رصيد السلف منفصل عن رصيد الراتب: السلفة لا تُعدّ راتباً مستحقاً، وتُخصم مرة واحدة فقط عند دفع الراتب.</p>

          <section className="card">
            <h3>السلف المفتوحة</h3>
            {s.advances.items.length === 0 ? <p className="muted">لا توجد سلف مفتوحة.</p> : (
              <div className="table-wrap">
                <table className="table-cards">
                  <thead><tr><th>السلفة</th><th>فترة الخصم</th><th className="num">المبلغ</th><th className="num">المُسوَّى</th><th className="num">المتبقي</th><th>الحالة</th><th /></tr></thead>
                  <tbody>
                    {s.advances.items.map((a) => (
                      <tr key={a.id}>
                        <td data-label="السلفة"><span className="mono">{a.ref}</span><div className="small-note muted">{fmtDateTime(a.requestedDate)}{a.note ? ` · ${a.note}` : ""}</div></td>
                        <td data-label="فترة الخصم">{a.deductionPeriodKey}</td>
                        <td className="num" data-label="المبلغ">{m(a.amount)}</td>
                        <td className="num" data-label="المُسوَّى">{m(a.settled)}</td>
                        <td className="num strong" data-label="المتبقي">{m(a.outstanding)}</td>
                        <td data-label="الحالة"><span className="pill">{ADVANCE_STATUS[a.status]}</span></td>
                        <td className="row-actions" data-label="">
                          {["pending", "disbursed"].includes(a.status) && !(a.settled > 0) && can("advances.manage") && <button className="btn small ghost" onClick={() => setModal({ kind: "reassign", advance: a })}>نقل الخصم</button>}
                          {["pending", "disbursed"].includes(a.status) && !(a.settled > 0) && can("advances.reverse") && <button className="btn small danger" onClick={() => setModal({ kind: "rev-adv", advance: a })}>{a.status === "pending" ? "إلغاء" : "عكس"}</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {tab === "statement" && (
        <>
          <div className="toolbar">
            <select aria-label="النطاق" value={lf.scope} onChange={(ev) => setLf({ ...lf, scope: ev.target.value, page: 1 })}><option value="period">الشهر {s.periodKey}</option><option value="all">كل الفترات</option></select>
            <select aria-label="نوع القيد" value={lf.type} onChange={(ev) => setLf({ ...lf, type: ev.target.value, page: 1 })}><option value="">كل الأنواع</option>{Object.entries(LEDGER_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select aria-label="حالة القيد" value={lf.state} onChange={(ev) => setLf({ ...lf, state: ev.target.value, page: 1 })}><option value="">كل الحالات</option>{Object.entries(LEDGER_STATE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <input type="date" aria-label="من تاريخ" value={lf.from} onChange={(ev) => setLf({ ...lf, from: ev.target.value, page: 1 })} />
            <input type="date" aria-label="إلى تاريخ" value={lf.to} onChange={(ev) => setLf({ ...lf, to: ev.target.value, page: 1 })} />
          </div>
          <ErrorBanner error={ledger.error} onRetry={ledger.reload} />
          {ledger.loading && !ledger.data ? <Loading /> : (ledger.data?.items.length || 0) === 0 ? <EmptyState title="لا توجد قيود" text="ستظهر هنا كل حركة مالية مرحَّلة لهذا الموظف." /> : (
            <>
              <p className="muted small-note">القيود المرحَّلة لا تُعدَّل ولا تُحذف؛ التصحيح بقيد عكسي يبقي الأصل ظاهراً.</p>
              <div className="table-wrap" aria-busy={ledger.loading}>
                <table className="table-cards">
                  <thead><tr><th>التاريخ</th><th>القيد</th><th>النوع</th><th>الفترة</th><th className="num">المبلغ</th><th>الحالة</th><th /></tr></thead>
                  <tbody>
                    {ledger.data.items.map((l) => (
                      <tr key={l.id} className={`statement-row ${l.state === "reversed" ? "cancelled" : ""}`}>
                        <td data-label="التاريخ">{fmtDateTime(l.date)}</td>
                        <td data-label="القيد"><span className="mono">{l.ref}</span>{l.reverses && <div className="small-note muted">يعكس {refOf[l.reverses] || "قيداً سابقاً"}</div>}{l.note && <div className="small-note muted">{l.note}</div>}</td>
                        <td data-label="النوع">{LEDGER_TYPE[l.type]}{l.reverseOf ? <span className="muted small-note"> ({LEDGER_TYPE[l.reverseOf]})</span> : ""}</td>
                        <td data-label="الفترة">{l.periodKey || "—"}</td>
                        <td className="num" data-label="المبلغ">{m(l.amount)}</td>
                        <td data-label="الحالة"><span className={`pill ${l.state === "reversed" ? "cancelled" : ""}`}>{LEDGER_STATE[l.state]}</span></td>
                        <td className="row-actions" data-label="">{rowAction(l)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={ledger.data.page} pages={ledger.data.pages} total={ledger.data.total} onChange={(p) => setLf({ ...lf, page: p })} />
            </>
          )}
        </>
      )}

      {modal?.kind === "pay" && <ExpenseFormModal preset={{ employeeId: id }} onClose={close} onDone={done("تم تسجيل دفعة الراتب كمصروف وحُدِّث حساب الموظف.")} />}
      {modal?.kind === "advance" && <AdvanceIssueModal employee={e} summary={s} onClose={close} onDone={done("تم تسجيل السلفة وصرفها.")} />}
      {modal?.kind === "adjust" && <AdjustmentModal employee={e} periodKey={s.periodKey} summary={s} onClose={close} onDone={done("تم تسجيل القيد.")} />}
      {modal?.kind === "edit" && <EmployeeFormModal employee={e} onClose={close} onDone={done("تم حفظ بيانات الموظف.")} />}
      {modal?.kind === "reassign" && <ReassignModal advance={modal.advance} periods={s.periods} onClose={close} onDone={done("تم نقل خصم السلفة.")} />}
      {modal?.kind === "settle" && (
        <ConfirmDialog title="تطبيق خصم السلف" confirmLabel="تطبيق الخصم" onCancel={close}
          message={`ستُسوّى السلف المجدولة لـ ${s.periodKey} بقدر ما يتسع له الراتب (${m(s.scheduledSettlement)})${s.carryForward > 0 ? ` ويُرحَّل ${m(s.carryForward)} للشهر التالي` : ""}. لا يخرج أي مبلغ من الصندوق.`}
          onConfirm={async () => { try { await api.post(`/employees/${id}/settle-advances`, { periodKey: s.periodKey }); setModal(null); setNotice("تم تطبيق الخصم."); refresh(); } catch (err) { setModal(null); setNotice(err.message); } }} />
      )}
      {modal?.kind === "close" && (
        <ReasonModal withReason={false} title={`إغلاق فترة ${s.periodKey}`} confirmLabel="إغلاق الفترة" path={`/employees/${id}/close-period`} body={{ periodKey: s.periodKey }} onClose={close} onDone={done("تم إغلاق الفترة.")}
          message="بعد الإغلاق لا تقبل الفترة أي تعديل عادي. يلزم أن تكون مدفوعة بالكامل (بما فيها خصم السلف) وبلا سلف مفتوحة عليها." />
      )}
      {modal?.kind === "rev-pay" && (
        <ReasonModal title={`عكس الدفعة ${modal.entry.ref}`} confirmLabel="عكس الدفعة" path={`/finance/expenses/${modal.entry.expenseId}/reverse`} onClose={close} onDone={done("تم عكس مصروف الراتب وإرجاع حركة الصندوق.")}
          message={`سيُعكس مصروف الراتب بقيمة ${m(modal.entry.amount)} ويُعاد المبلغ إلى الصندوق إن كان الدفع نقدياً، ويعود إلى المتبقي. القيد الأصلي يبقى ظاهراً.`} />
      )}
      {modal?.kind === "rev-settle" && (
        <ReasonModal title={`عكس التسوية ${modal.entry.ref}`} confirmLabel="عكس التسوية" path={`/employee-advances/${modal.entry.advanceId}/settlements/${modal.entry.id}/reverse`} onClose={close} onDone={done("تم عكس التسوية.")}
          message={`سيعود ${m(modal.entry.amount)} إلى رصيد السلفة القائم ويُجدوَل للخصم من جديد.`} />
      )}
      {modal?.kind === "rev-adjust" && (
        <ReasonModal title={`عكس القيد ${modal.entry.ref}`} confirmLabel="عكس القيد" path={`/payroll-periods/${modal.entry.periodId}/adjustments/${modal.entry.id}/reverse`} onClose={close} onDone={done("تم عكس القيد.")}
          message={`سيُلغى أثر ${LEDGER_TYPE[modal.entry.type]} بقيمة ${m(modal.entry.amount)}.`} />
      )}
      {modal?.kind === "rev-adv" && (
        <ReasonModal title={modal.advance.status === "pending" ? `إلغاء السلفة ${modal.advance.ref}` : `عكس السلفة ${modal.advance.ref}`} confirmLabel={modal.advance.status === "pending" ? "إلغاء السلفة" : "عكس السلفة"} path={`/employee-advances/${modal.advance.id}/reversals`} onClose={close} onDone={done("تم تنفيذ العملية على السلفة.")}
          message={modal.advance.status === "pending" ? "السلفة لم تُصرف: ستُلغى دون أي أثر على الصندوق." : `ستُعكس السلفة المصروفة ويُعاد ${m(modal.advance.amount)} إلى الصندوق إن كان الصرف نقدياً.`} />
      )}
    </div>
  );
}
