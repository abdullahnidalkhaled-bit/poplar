import PageHeader from "../components/ui/PageHeader.jsx";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import useDebounced from "../hooks/useDebounced.js";
import Pagination from "../components/ui/Pagination.jsx";
import Modal from "../components/ui/Modal.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { fmtDateTime, MOVEMENT_LABEL, PLACE, SERIES_KIND_LABEL, dayStartIso, dayEndIso } from "../utils.js";

const SORTS = [["receivedAt", "تاريخ الاستلام"], ["createdAt", "تاريخ الإنشاء"], ["seriesNo", "رقم الرتل"], ["modelNumber", "رقم الموديل"]];

// سجل المخزون على مستوى الأرتال: صف لكل رتل (لا لكل قطعة)، والنقر يفتح تفاصيله
export default function InventoryLog() {
  const [sp, setSp] = useSearchParams();
  const get = (k, d = "") => sp.get(k) || d;
  const page = Number(get("page")) || 1;
  const [text, setText] = useState(get("q"));
  const dq = useDebounced(text, 300);
  const [open, setOpen] = useState(null);

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
    q: get("q"), location: get("location"), status: get("status"), ownership: get("ownership"), sort: get("sort", "receivedAt"), dir: get("dir", "desc"), page, limit: 25,
    from: get("from") ? dayStartIso(get("from")) : "", to: get("to") ? dayEndIso(get("to")) : "",
  };
  const { data, error, loading, reload } = useAsync(() => api.get(`/series${qs(params)}`), [JSON.stringify(params)]);
  const items = data?.items || [];
  const hasFilters = ["q", "location", "status", "ownership", "from", "to"].some((k) => get(k));

  return (
    <div>
      <PageHeader title="سجل الأرتال" sub={data ? `${data.total.toLocaleString("en-US")} رتل` : null} />

      <div className="toolbar">
        <div className="search-bar grow" role="search"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="رقم الرتل أو رقم الموديل أو اسمه" aria-label="بحث في الأرتال" /></div>
        <select aria-label="الموقع" value={get("location")} onChange={(e) => setParam({ location: e.target.value })}>
          <option value="">كل المواقع</option><option value="shop">المحل</option><option value="warehouse">المستودع</option>
        </select>
        <select aria-label="الحالة" value={get("status")} onChange={(e) => setParam({ status: e.target.value })}>
          <option value="">كل الحالات</option><option value="active">نشط</option><option value="depleted">منتهي</option>
        </select>
        <select aria-label="الملكية" value={get("ownership")} onChange={(e) => setParam({ ownership: e.target.value })}>
          <option value="">كل الملكيات</option><option value="owned">مملوكة</option><option value="consignment">بضاعة أمانة</option>
        </select>
        <label className="inline-field">من <input type="date" value={get("from")} onChange={(e) => setParam({ from: e.target.value })} /></label>
        <label className="inline-field">إلى <input type="date" value={get("to")} onChange={(e) => setParam({ to: e.target.value })} /></label>
        <select aria-label="ترتيب حسب" value={get("sort", "receivedAt")} onChange={(e) => setParam({ sort: e.target.value === "receivedAt" ? "" : e.target.value })}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>ترتيب: {l}</option>)}
        </select>
        <button className="btn small ghost" onClick={() => setParam({ dir: get("dir", "desc") === "desc" ? "asc" : "" })} aria-label="عكس الترتيب">
          {get("dir", "desc") === "desc" ? "↓ تنازلي" : "↑ تصاعدي"}
        </button>
        {hasFilters && <button className="btn small ghost" onClick={() => { setText(""); setSp({}); }}>مسح الفلاتر</button>}
      </div>

      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : !error && items.length === 0 ? (
        <EmptyState title={hasFilters ? "لا توجد أرتال مطابقة" : "لا توجد أرتال بعد"} text={hasFilters ? "غيّر الفلاتر أو امسحها." : "تظهر هنا الأرتال المستلمة مع كل شحنة."} />
      ) : (
        <>
          <div className="table-wrap" aria-busy={loading}>
            <table className="table-cards log-table">
              <thead><tr><th>الرتل</th><th>الموديل</th><th>الموقع</th><th>المقاسات</th><th className="num">القطع</th><th>الحالة</th><th>الاستلام</th></tr></thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="series-row" tabIndex={0} onClick={() => setOpen(s.seriesNo)} onKeyDown={(e) => e.key === "Enter" && setOpen(s.seriesNo)}>
                    <td data-label="الرتل"><button type="button" className="series-link mono" onClick={(e) => { e.stopPropagation(); setOpen(s.seriesNo); }}>{s.seriesNo}</button><div className="small-note">{SERIES_KIND_LABEL[s.kind]}{s.ownership === "consignment" && <> · <span className="pill consign">أمانة</span></>}</div></td>
                    <td data-label="الموديل"><span className="mono strong">{s.modelNumber}</span><div className="small-note">{[s.name, s.type, s.cut].filter(Boolean).join(" · ")}</div></td>
                    <td data-label="الموقع">{PLACE[s.location]}</td>
                    <td data-label="المقاسات" className="mono" dir="ltr">{s.sizeSummary || "—"}</td>
                    <td data-label="القطع" className="num">{s.totalPieces}</td>
                    <td data-label="الحالة"><span className={`pill ${s.status}`}>{s.status === "active" ? "نشط" : "منتهي"}</span></td>
                    <td data-label="الاستلام" className="nowrap">{fmtDateTime(s.receivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={(p) => setParam({ page: p > 1 ? String(p) : "" })} />
        </>
      )}

      {open && <SeriesDetail seriesNo={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </div>
  );
}

function SeriesDetail({ seriesNo, onClose, onOpen }) {
  const { data: s, error, loading, reload } = useAsync(() => api.get(`/series/${encodeURIComponent(seriesNo)}`), [seriesNo]);
  return (
    <Modal title={`الرتل ${seriesNo}`} onClose={onClose} wide>
      {loading && <Loading />}
      <ErrorBanner error={error} onRetry={reload} />
      {s && (
        <div className="series-detail">
          <dl>
            <dt>الموديل</dt><dd><Link to={`/models/${s.modelNumber}`} className="mono strong" onClick={onClose}>{s.modelNumber}</Link> · {s.name}</dd>
            <dt>الموقع</dt><dd>{PLACE[s.location]}</dd>
            <dt>النوع</dt><dd>{SERIES_KIND_LABEL[s.kind]}{s.origin && <> من <button type="button" className="series-link mono" onClick={() => onOpen(s.origin.seriesNo)}>{s.origin.seriesNo}</button></>}</dd>
            <dt>الحالة</dt><dd>{s.status === "active" ? "نشط" : "منتهي (محفوظ في السجل)"}{s.ownership === "consignment" && <> · <span className="pill consign">بضاعة أمانة</span></>}</dd>
            <dt>الاستلام</dt><dd>{fmtDateTime(s.receivedAt)}{s.shipmentRef ? ` · ${s.shipmentRef}` : ""}</dd>
            {s.derived.length > 0 && <><dt>نُقل منه إلى</dt><dd>{s.derived.map((d) => <button key={d.seriesNo} type="button" className="series-link mono" onClick={() => onOpen(d.seriesNo)}>{d.seriesNo} ({PLACE[d.location]}) </button>)}</dd></>}
          </dl>
          <div className="table-wrap">
            <table>
              <thead><tr><th>المقاس</th><th className="num">عند الاستلام</th><th className="num">الحالي</th></tr></thead>
              <tbody>
                {s.sizes.map((x) => <tr key={x.size}><th scope="row"><span className="size-chip">{x.size}</span></th><td className="num">{x.initialQty}</td><td className="num">{x.qty}</td></tr>)}
              </tbody>
              <tfoot><tr><th scope="row">المجموع</th><td className="num">{s.sizes.reduce((n, x) => n + x.initialQty, 0)}</td><td className="num"><b>{s.totalPieces}</b></td></tr></tfoot>
            </table>
          </div>
          <h3>الحركات على هذا الرتل</h3>
          {s.movements.length === 0 ? <p className="muted">لا حركات مسجّلة.</p> : (
            <ul className="attn-list">
              {s.movements.map((m) => (
                <li key={m.id}>
                  <span><span className={`pill mv-${m.type}`}>{MOVEMENT_LABEL[m.type]}</span> {m.size} × {m.seriesQty}{m.from || m.to ? ` · ${[m.from && PLACE[m.from], m.to && PLACE[m.to]].filter(Boolean).join(" ← ")}` : ""}{m.ref ? ` · ${m.ref}` : ""}</span>
                  <span className="muted small-note">{fmtDateTime(m.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
