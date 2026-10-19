import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs } from "../api.js";
import { useAuth } from "../auth.jsx";
import useAsync from "../hooks/useAsync.js";
import useDebounced from "../hooks/useDebounced.js";
import PageHeader from "../components/ui/PageHeader.jsx";
import Pagination from "../components/ui/Pagination.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { ORIGIN_LABEL } from "../utils.js";

const MATCH_LABEL = { model_number_exact: "تطابق رقم الموديل", model_number_prefix: "رقم الموديل يبدأ بـ", name: "تطابق الاسم", partial: "تطابق جزئي" };
const STATUS_OPTIONS = [["", "كل الحالات"], ["out", "فيها مقاسات نفدت"], ["transfer", "جاهزة للنقل من المستودع"]];

export default function Models() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const get = (k) => sp.get(k) || "";
  const page = Number(get("page")) || 1;
  const [text, setText] = useState(get("q"));
  const debounced = useDebounced(text, 300);

  const setParam = (patch) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!("page" in patch)) next.delete("page");
    setSp(next, { replace: true });
  };
  useEffect(() => {
    if (debounced !== get("q")) setParam({ q: debounced.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const facets = useAsync(() => api.get("/models/facets"), []);
  const filters = { q: get("q"), type: get("type"), brand: get("brand"), origin: get("origin"), status: get("status") };
  const list = useAsync(() => api.get(`/models${qs({ ...filters, page, limit: 20 })}`), [get("q"), get("type"), get("brand"), get("origin"), get("status"), page]);
  const f = facets.data || { brands: [], types: [] };
  const items = list.data?.items || [];
  const searching = Boolean(get("q"));

  return (
    <div>
      <PageHeader title="الموديلات" sub={list.data ? `${list.data.total.toLocaleString("en-US")} موديل` : null}
        primary={can("models.manage") && <Link className="btn primary" to="/models/new">موديل جديد</Link>} />

      <div className="toolbar">
        <div className="search-bar grow" role="search">
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="رقم الموديل (FAF-001) أو اسمه أو جزء منه" aria-label="بحث" autoFocus />
        </div>
        <select aria-label="النوع" value={filters.type} onChange={(e) => setParam({ type: e.target.value })}>
          <option value="">كل الأنواع</option>
          {f.types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select aria-label="البراند" value={filters.brand} onChange={(e) => setParam({ brand: e.target.value })}>
          <option value="">كل البراندات</option>
          {f.brands.map((b) => <option key={b}>{b}</option>)}
        </select>
        <select aria-label="الأصل" value={filters.origin} onChange={(e) => setParam({ origin: e.target.value })}>
          <option value="">أجنبي ووطني</option>
          <option value="foreign">أجنبي</option>
          <option value="local">وطني</option>
        </select>
        <select aria-label="حالة المخزون" value={filters.status} onChange={(e) => setParam({ status: e.target.value })}>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : !list.error && items.length === 0 ? (
        <EmptyState
          title={searching ? `لا يوجد موديل مطابق لـ "${get("q")}"` : "لا توجد موديلات"}
          text={searching ? "تأكد من رقم الموديل أو جرّب جزءاً من الاسم، أو أنشئ موديلاً جديداً." : "ابدأ بإضافة أول موديل."}
        >
          {can("models.manage") && <Link className="btn primary" to="/models/new">إضافة موديل</Link>}
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table-cards">
              <thead>
                <tr>
                  <th scope="col">رقم الموديل</th><th scope="col">الاسم</th><th scope="col">النوع · القَصّة</th>
                  <th scope="col" className="num">المحل</th><th scope="col" className="num">المستودع</th><th scope="col" className="num">الإجمالي</th>
                  <th scope="col">المقاسات</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id}>
                    <th scope="row" data-label="رقم الموديل">
                      <Link to={`/models/${m.modelNumber}`} className="mono strong">{m.modelNumber}</Link>
                      {searching && m.matchType && <div className="small-note muted">{MATCH_LABEL[m.matchType]}</div>}
                    </th>
                    <td data-label="الاسم"><b>{m.brand}</b> {m.name} <span className={`pill ${m.origin}`}>{ORIGIN_LABEL[m.origin]}</span></td>
                    <td data-label="النوع · القَصّة">{m.type}{m.cut ? ` · ${m.cut}` : ""}</td>
                    <td className="num" data-label="المحل">{m.totals.shop}</td>
                    <td className="num" data-label="المستودع">{m.totals.warehouse}</td>
                    <td className="num strong" data-label="الإجمالي">{m.totals.combined}</td>
                    <td data-label="المقاسات">
                      <span className="chips">
                        {m.sizes.map((s) => (
                          <span key={s.size} className={`size-chip ${s.needsFactoryRestock ? "danger" : s.canTransfer ? "info" : ""}`}
                            title={`${s.size}: محل ${s.shopQty} / مستودع ${s.warehouseQty}`}>
                            {s.size} <small>{s.totalQty}</small>
                            {s.needsFactoryRestock && <span className="sr-only"> نفد</span>}
                          </span>
                        ))}
                      </span>
                      {m.restockSizes.length > 0 && <div className="size-note danger-text">نفدت: {m.restockSizes.join("، ")}</div>}
                      {m.transferableSizes.length > 0 && <div className="size-note">للنقل: {m.transferableSizes.join("، ")}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!searching && <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={(p) => setParam({ page: p > 1 ? String(p) : "" })} />}
        </>
      )}
    </div>
  );
}
