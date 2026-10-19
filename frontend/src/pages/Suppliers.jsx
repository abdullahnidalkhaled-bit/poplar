import PageHeader from "../components/ui/PageHeader.jsx";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import useDebounced from "../hooks/useDebounced.js";
import Pagination from "../components/ui/Pagination.jsx";
import StatCard from "../components/ui/StatCard.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { SupplierFormModal } from "../components/suppliers/SupplierForms.jsx";
import { money, num, ACCOUNT_STATUS } from "../utils.js";

export const StatusPill = ({ status }) => <span className={`pill acct-${status}`}>{ACCOUNT_STATUS[status]}</span>;

// مبلغ لكل عملة على حدة (لا مجموع مشترك): يعرض السطر غير الصفري فقط، وإلا شرطة
export function Dual({ v, kind }) {
  const lines = ["USD", "SYP"].filter((c) => Math.abs(v?.[c] || 0) > 0.004);
  if (!lines.length) return <span className="dual"><span className="zero">—</span></span>;
  return (
    <span className="dual">
      {lines.map((c) => {
        const x = v[c];
        const cls = kind === "net" ? (x > 0 ? "amount-due" : "amount-adv") : kind === "gross" ? "amount-due" : kind === "advance" ? "amount-adv" : "";
        const text = kind === "net" ? `${x > 0 ? "عليكم" : "لكم"} ${money(Math.abs(x), c)}` : money(x, c);
        return <span key={c} className={cls}>{text}</span>;
      })}
    </span>
  );
}

// لوحة حسابات التجار (للمالك فقط). كل رقم بعملته: الدولار والليرة حسابان مستقلان ولا يوجد أي مجموع أو تحويل بينهما
export default function Suppliers() {
  const [sp, setSp] = useSearchParams();
  const get = (k, d = "") => sp.get(k) || d;
  const page = Number(get("page")) || 1;
  const [text, setText] = useState(get("q"));
  const dq = useDebounced(text, 300);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");

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

  const summary = useAsync(() => api.get("/suppliers/summary"), []);
  const params = { q: get("q"), active: get("active", "true"), account: get("account"), page, limit: 20 };
  const list = useAsync(() => api.get(`/suppliers${qs(params)}`), [JSON.stringify(params)]);
  const s = summary.data;
  const items = list.data?.items || [];
  const hasFilters = ["q", "account"].some((k) => get(k)) || get("active", "true") !== "true";
  const reloadAll = () => { summary.reload(); list.reload(); };

  return (
    <div>
      <PageHeader title="حسابات التجار" primary={<button className="btn primary" onClick={() => setCreating(true)}>تاجر جديد</button>} />
      {notice && <div className="banner ok" role="status"><span>{notice}</span><button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button></div>}

      <ErrorBanner error={summary.error} onRetry={summary.reload} />
      {s && (
        <div className="stats">
          <StatCard label="التجار الفعّالون" value={num(s.activeSuppliers)} />
          <StatCard label="مستحق للتجار — بالدولار" value={money(s.totals.USD.grossPayable, "USD")} tone={s.totals.USD.grossPayable > 0 ? "loss" : ""} hint="فواتير دولارية غير مسددة" />
          <StatCard label="مستحق للتجار — بالليرة" value={money(s.totals.SYP.grossPayable, "SYP")} tone={s.totals.SYP.grossPayable > 0 ? "loss" : ""} hint="فواتير بالليرة غير مسددة" />
          <StatCard label="سلف لدى التجار — دولار" value={money(s.totals.USD.advance, "USD")} tone="advance" hint="دفعات لم تُخصَّص" />
          <StatCard label="سلف لدى التجار — ليرة" value={money(s.totals.SYP.advance, "SYP")} tone="advance" hint="دفعات لم تُخصَّص" />
          <StatCard label="بضاعة أمانة لديكم" value={`${num(s.consignmentPieces)} قطعة`} tone="consign" hint={`بأسعار الاتفاق: ${[s.consignmentValueUsd > 0 && money(s.consignmentValueUsd, "USD"), s.consignmentValueSyp > 0 && money(s.consignmentValueSyp, "SYP")].filter(Boolean).join(" + ") || "—"}${s.consignmentUnpricedPieces ? ` · ${num(s.consignmentUnpricedPieces)} بلا سعر` : ""} · ليست التزاماً`} />
        </div>
      )}
      {s && <p className="hint-box">الدولار والليرة حسابان مستقلان: لا مجموع مشترك ولا تحويل بينهما. المستحقات والسلف تُعرض منفصلة ولا تُخفي إحداهما الأخرى.</p>}

      {s?.attention.length > 0 && (
        <section className="card">
          <h3>تجار يحتاجون انتباهاً</h3>
          <ul className="attn-list">
            {s.attention.map((a) => (
              <li key={a.id}>
                <Link to={`/suppliers/${a.id}`} className="strong">{a.name}</Link>
                <span className="muted small-note">
                  {["USD", "SYP"].filter((c) => a.positions[c].grossPayable > 0).map((c) => <span key={c} className="amount-due">مستحق {money(a.positions[c].grossPayable, c)} · </span>)}
                  {a.consignmentPieces > 0 && `أمانة ${num(a.consignmentPieces)} قطعة`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="toolbar">
        <div className="search-bar grow" role="search"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="اسم التاجر أو هاتفه أو عنوانه" aria-label="بحث في التجار" /></div>
        <select aria-label="الحالة المحاسبية" value={get("account")} onChange={(e) => setParam({ account: e.target.value })}>
          <option value="">كل الحسابات</option><option value="due">عليه مستحقات</option><option value="advance">رصيد سلفة</option><option value="mixed">مستحقات وسلف معاً</option><option value="settled">مسدد بالكامل</option>
        </select>
        <select aria-label="حالة التاجر" value={get("active", "true")} onChange={(e) => setParam({ active: e.target.value === "true" ? "" : e.target.value })}>
          <option value="true">الفعّالون</option><option value="false">المعطّلون</option><option value="all">الكل</option>
        </select>
        {hasFilters && <button className="btn small ghost" onClick={() => { setText(""); setSp({}); }}>مسح الفلاتر</button>}
      </div>

      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : !list.error && items.length === 0 ? (
        <EmptyState title={hasFilters ? "لا يوجد تجار مطابقون" : "لا يوجد تجار بعد"} text={hasFilters ? "غيّر البحث أو امسح الفلاتر." : "أضف أول تاجر لتبدأ بتسجيل فواتيره ودفعاته وبضاعته."}>
          {!hasFilters && <button className="btn primary" onClick={() => setCreating(true)}>تاجر جديد</button>}
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap" aria-busy={list.loading}>
            <table className="table-cards">
              <thead><tr><th>التاجر</th><th>الحالة</th><th className="num">المستحق الإجمالي</th><th className="num">السلف المتاحة</th><th className="num">الصافي</th><th className="num">أمانة لديكم</th></tr></thead>
              <tbody>
                {items.map((x) => {
                  const P = (k) => ({ USD: x.positions.USD[k], SYP: x.positions.SYP[k] });
                  return (
                    <tr key={x.id} className={x.active ? "" : "cancelled"}>
                      <td data-label="التاجر">
                        <Link to={`/suppliers/${x.id}`} className="strong">{x.name}</Link>{!x.active && <> <span className="pill cancelled">معطّل</span></>}
                        <div className="small-note muted mono" dir="ltr" style={{ unicodeBidi: "isolate", textAlign: "right" }}>{(x.phone || "").replace(/\s+/g, "")}</div>
                      </td>
                      <td data-label="الحالة"><StatusPill status={x.status} /></td>
                      <td data-label="المستحق الإجمالي" className="num"><Dual v={P("grossPayable")} kind="gross" /></td>
                      <td data-label="السلف المتاحة" className="num"><Dual v={P("advance")} kind="advance" /></td>
                      <td data-label="الصافي" className="num"><Dual v={P("net")} kind="net" /></td>
                      <td data-label="أمانة لديكم" className="num">{x.consignmentPieces ? <>{num(x.consignmentPieces)} <span className="muted small-note">قطعة{x.consignmentUnpricedPieces ? " · بعضها بلا سعر" : ""}</span><div className="small-note muted">{[x.consignmentValueUsd > 0 && money(x.consignmentValueUsd, "USD"), x.consignmentValueSyp > 0 && money(x.consignmentValueSyp, "SYP")].filter(Boolean).join(" + ")}</div></> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onChange={(p) => setParam({ page: p > 1 ? String(p) : "" })} />
        </>
      )}
      {creating && <SupplierFormModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); setNotice("تمت إضافة التاجر."); reloadAll(); }} />}
    </div>
  );
}
