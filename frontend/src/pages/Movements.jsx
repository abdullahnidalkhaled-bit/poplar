import PageHeader from "../components/ui/PageHeader.jsx";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import useDebounced from "../hooks/useDebounced.js";
import Pagination from "../components/ui/Pagination.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { fmtDateTime, usd, MOVEMENT_LABEL, PLACE, dayStartIso, dayEndIso } from "../utils.js";

const SORTS = [["createdAt", "التاريخ"], ["type", "نوع العملية"], ["modelNumber", "رقم الموديل"], ["qty", "الكمية"]];
const ICON = { sale: "↗", receive: "↓", transfer: "⇄", return: "↩", return_damaged: "✖", damaged: "✖", adjust: "≈", cancel: "↩", supplier_return: "⇠" };

const Delta = ({ m }) => {
  if (m.delta === 0) return <span className="muted">{m.qty} (بلا أثر على الإجمالي)</span>;
  return <span className={m.delta > 0 ? "gain-text" : "loss-text"}>{m.delta > 0 ? "+" : "−"}{Math.abs(m.delta)}</span>;
};

export default function Movements() {
  const [sp, setSp] = useSearchParams();
  const get = (k, d = "") => sp.get(k) || d;
  const page = Number(get("page")) || 1;
  const [text, setText] = useState(get("q"));
  const dq = useDebounced(text, 300);

  const setParam = (patch) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!("page" in patch)) next.delete("page");
    setSp(next, { replace: true });
  };
  useEffect(() => {
    if (dq !== get("q")) setParam({ q: dq.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const params = {
    q: get("q"), type: get("type"), location: get("location"), sort: get("sort", "createdAt"), dir: get("dir", "desc"), page, limit: 25,
    from: get("from") ? dayStartIso(get("from")) : "", to: get("to") ? dayEndIso(get("to")) : "",
  };
  const { data, error, loading, reload } = useAsync(() => api.get(`/movements${qs(params)}`), [JSON.stringify(params)]);
  const items = data?.items || [];
  const hasFilters = ["q", "type", "location", "from", "to"].some((k) => get(k));

  return (
    <div>
      <PageHeader title="سجل المخزون" sub={data ? `${data.total.toLocaleString("en-US")} حركة` : null} />

      <div className="toolbar">
        <div className="search-bar grow" role="search"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="رقم الموديل أو اسمه أو رقم الفاتورة" aria-label="بحث في السجل" /></div>
        <select aria-label="نوع العملية" value={get("type")} onChange={(e) => setParam({ type: e.target.value })}>
          <option value="">كل العمليات</option>
          {Object.entries(MOVEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="الموقع" value={get("location")} onChange={(e) => setParam({ location: e.target.value })}>
          <option value="">كل المواقع</option><option value="shop">المحل</option><option value="warehouse">المستودع</option>
        </select>
        <label className="inline-field">من <input type="date" value={get("from")} onChange={(e) => setParam({ from: e.target.value })} /></label>
        <label className="inline-field">إلى <input type="date" value={get("to")} onChange={(e) => setParam({ to: e.target.value })} /></label>
        <select aria-label="ترتيب حسب" value={get("sort", "createdAt")} onChange={(e) => setParam({ sort: e.target.value === "createdAt" ? "" : e.target.value })}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>ترتيب: {l}</option>)}
        </select>
        <button className="btn small ghost" onClick={() => setParam({ dir: get("dir", "desc") === "desc" ? "asc" : "" })} aria-label="عكس الترتيب">
          {get("dir", "desc") === "desc" ? "↓ تنازلي" : "↑ تصاعدي"}
        </button>
        {hasFilters && <button className="btn small ghost" onClick={() => { setText(""); setSp({}); }}>مسح الفلاتر</button>}
      </div>

      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : !error && items.length === 0 ? (
        <EmptyState title={hasFilters ? "لا توجد حركات مطابقة" : "لا توجد حركات بعد"} text={hasFilters ? "غيّر الفلاتر أو امسحها." : "تظهر هنا كل عمليات الاستلام والنقل والبيع والتالف والجرد."} />
      ) : (
        <>
          <div className="table-wrap" aria-busy={loading}>
            <table className="table-cards log-table">
              <thead>
                <tr><th>التاريخ</th><th>العملية</th><th>الموديل</th><th>المقاس</th><th className="num">الأثر</th><th>من ← إلى</th><th>قبل ← بعد (محل / مستودع)</th><th>المرجع / السبب</th></tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m._id}>
                    <td data-label="التاريخ" className="nowrap">{fmtDateTime(m.createdAt)}</td>
                    <td data-label="العملية"><span className={`pill mv-${m.type}`}><span aria-hidden="true">{ICON[m.type]}</span> {MOVEMENT_LABEL[m.type]}</span></td>
                    <td data-label="الموديل">
                      {m.modelNumber ? <Link to={`/models/${m.modelNumber}`} className="mono strong">{m.modelNumber}</Link> : <span className="muted">—</span>}
                      <div className="small-note">{m.brand} {m.name}</div>
                    </td>
                    <td data-label="المقاس"><span className="size-chip">{m.size || "—"}</span></td>
                    <td data-label="الأثر" className="num"><Delta m={m} /></td>
                    <td data-label="من ← إلى">{[m.from && PLACE[m.from], m.to && PLACE[m.to]].filter(Boolean).join(" ← ") || "—"}</td>
                    <td data-label="قبل ← بعد" className="nowrap">
                      {m.before && m.after ? <span className="mono">{m.before.shop} / {m.before.warehouse} ← {m.after.shop} / {m.after.warehouse}</span> : <span className="muted" title="لم تُسجَّل الكميات لهذه الحركة">غير مسجّل</span>}
                    </td>
                    <td data-label="المرجع / السبب" className="muted">{[m.ref, m.reason].filter(Boolean).join(" · ") || "—"}{m.costUsd > 0 && <div className="small-note">قيمة {usd(m.costUsd)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={(p) => setParam({ page: p > 1 ? String(p) : "" })} />
        </>
      )}
    </div>
  );
}
