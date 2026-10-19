import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "../api.js";
import { useAuth } from "../auth.jsx";
import useAsync from "../hooks/useAsync.js";
import useDebounced from "../hooks/useDebounced.js";
import PageHeader from "../components/ui/PageHeader.jsx";
import Pagination from "../components/ui/Pagination.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { EmployeeFormModal } from "../components/payroll/PayrollForms.jsx";
import { money } from "../utils.js";
import { EMP_STATUS, INDICATOR, INDICATOR_TONE } from "../payrollUtils.js";

export const Indicator = ({ value }) => <span className={`pill tone-${INDICATOR_TONE[value] || "muted"}`}>{INDICATOR[value] || value}</span>;

// الموظفون: نقطة الدخول إلى حساب الموظف المالي (الراتب والسلف). الضغط على الصف أو الاسم يفتح حسابه.
// كل موظف بعملته: الدولار والليرة حسابان مستقلان ولا مجموع مشترك بينهما.
export default function Employees() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const get = (k) => sp.get(k) || "";
  const page = Number(get("page")) || 1;
  const periodParam = get("period"); // الشهر الحالي والافتراضي من الخادم؛ بلا اختيار يُحدَّد لكل موظف شهره الافتراضي
  const [text, setText] = useState(get("q"));
  const debounced = useDebounced(text, 300);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");

  const setParam = (patch) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!("page" in patch)) next.delete("page");
    setSp(next, { replace: true });
  };
  useEffect(() => { if (debounced !== get("q")) setParam({ q: debounced.trim() }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [debounced]);

  const list = useAsync(() => api.get(`/employees${qs({ q: get("q"), status: get("status"), periodKey: periodParam, page, limit: 20 })}`), [get("q"), get("status"), periodParam, page]);
  const items = list.data?.items || [];
  const hasFilters = Boolean(get("q") || get("status"));
  const open = (e) => nav(`/employees/${e.id}${get("period") ? `?period=${get("period")}` : ""}`);

  return (
    <div>
      <PageHeader
        title="الموظفون" sub="الحسابات المالية: الرواتب والسلف"
        primary={can("employees.manage") && <button className="btn primary" onClick={() => setCreating(true)}>موظف جديد</button>}
        more={[{ label: "حسابات الدخول والصلاحيات", to: "/users", hidden: !can("users.manage") }]}
      />
      {notice && <div className="banner ok" role="status"><span>{notice}</span><button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button></div>}

      <div className="toolbar">
        <div className="search-bar grow" role="search"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="اسم الموظف أو رقمه (EMP-000001)" aria-label="بحث عن موظف" /></div>
        <select aria-label="حالة التوظيف" value={get("status")} onChange={(e) => setParam({ status: e.target.value })}>
          <option value="">كل الحالات</option>{Object.entries(EMP_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="inline-field">الشهر
          <input type="month" value={periodParam || list.data?.currentKey || ""} max={list.data?.currentKey} onChange={(e) => setParam({ period: e.target.value && e.target.value !== list.data?.currentKey ? e.target.value : "" })} aria-label="شهر الراتب" />
        </label>
        {hasFilters && <button className="btn small ghost" onClick={() => { setText(""); setSp({}); }}>مسح الفلاتر</button>}
      </div>

      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : !list.error && items.length === 0 ? (
        <EmptyState title={hasFilters ? "لا يوجد موظفون مطابقون" : "لا يوجد موظفون بعد"} text={hasFilters ? "غيّر البحث أو امسح الفلاتر." : "أضف أول موظف لتبدأ بتسجيل الرواتب والسلف."}>
          {!hasFilters && can("employees.manage") && <button className="btn primary" onClick={() => setCreating(true)}>موظف جديد</button>}
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table-cards">
              <thead>
                <tr><th>الموظف</th><th>الحالة</th><th>الراتب الشهري</th><th className="num">المتبقي للدفع</th><th className="num">سلف قائمة</th><th>وضع الشهر</th></tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className={`clickable ${e.status === "active" ? "" : "cancelled"}`} onClick={() => open(e)}>
                    <td data-label="الموظف">
                      <Link to={`/employees/${e.id}${get("period") ? `?period=${get("period")}` : ""}`} className="strong" onClick={(ev) => ev.stopPropagation()}>{e.name}</Link>
                      <div className="small-note muted"><span className="mono">{e.number}</span>{e.jobTitle ? ` · ${e.jobTitle}` : ""}</div>
                    </td>
                    <td data-label="الحالة">{EMP_STATUS[e.status]}</td>
                    <td data-label="الراتب الشهري">{money(e.salary, e.currency)}</td>
                    <td className="num strong" data-label="المتبقي للدفع">{money(e.due.remaining, e.currency)}<div className="small-note muted">{e.periodKey}{e.due.scheduledSettlement > 0 ? ` · بعد خصم سلف ${money(e.due.scheduledSettlement, e.currency)}` : ""}</div></td>
                    <td className="num" data-label="سلف قائمة">{e.advancesOutstanding > 0 ? <span className="amount-due">{money(e.advancesOutstanding, e.currency)}</span> : <span className="muted">—</span>}</td>
                    <td data-label="وضع الشهر"><Indicator value={e.indicator} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={(p) => setParam({ page: p > 1 ? String(p) : "" })} />
        </>
      )}
      <p className="muted small-note">يُدفع الراتب من المالية ← المصروفات (فئة «رواتب») أو من حساب الموظف. كل موظف يُعرض بعملته ولا مجموع مشتركاً بين الدولار والليرة.</p>
      {creating && <EmployeeFormModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); setNotice("تمت إضافة الموظف."); list.reload(); }} />}
    </div>
  );
}
