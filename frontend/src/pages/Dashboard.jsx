import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import useAsync from "../hooks/useAsync.js";
import PageHeader from "../components/ui/PageHeader.jsx";
import StatCard from "../components/ui/StatCard.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { num, usd, fmtDateTime, MOVEMENT_LABEL } from "../utils.js";

const Section = ({ title, count, tone, children }) => (
  <section className="card">
    <h3>{title} {count > 0 && <span className={`count-pill ${tone}`}>{count}</span>}</h3>
    {children}
  </section>
);

export default function Dashboard() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const { data: d, error, loading, reload } = useAsync(() => api.get("/reports/dashboard"), []);

  const restock = d?.attention.filter((m) => m.restockSizes.length) || [];
  const transfer = d?.attention.filter((m) => m.transferSizes.length) || [];

  return (
    <div>
      <PageHeader
        title="لوحة المخزون"
        primary={can("stock.receive") && <Link className="btn primary" to="/receive">استلام شحنة</Link>}
        more={[{ label: "موديل جديد", to: "/models/new", hidden: !can("models.manage") }, { label: "مسح QR", to: "/scan", hidden: !can("models.read") }]}
      />

      <form className="search-bar" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/models?q=${encodeURIComponent(q)}`); }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث برقم الموديل (FAF-001) أو باسمه" aria-label="بحث عن موديل" />
        <button className="btn primary">بحث</button>
      </form>

      <ErrorBanner error={error} onRetry={reload} />
      {loading && !d ? <Loading /> : d && (
        <>
          <div className="stats">
            <StatCard label="في المحل" value={num(d.totals.shop)} hint="قطعة" />
            <StatCard label="في المستودع" value={num(d.totals.warehouse)} hint="قطعة" />
            <StatCard label="الإجمالي" value={num(d.totals.combined)} hint={`${d.totals.models} موديل · ${d.totals.sizes} مقاس`} />
            {can("costs.view") && <StatCard label="قيمة المخزون بالجملة" value={usd(d.totals.costValueUsd)} hint={`بسعر البيع ${usd(d.totals.sellValueUsd)}`} />}
          </div>

          {d.totals.models === 0 ? (
            <EmptyState title="لا توجد موديلات بعد" text="ابدأ بإضافة أول موديل مع مقاساته وكمياته.">
              {can("models.manage") && <Link className="btn primary" to="/models/new">إضافة موديل</Link>}
            </EmptyState>
          ) : (
            <div className="two-col">
              <Section title="تحتاج طلباً من المصنع" count={d.counts.restock} tone="danger">
                <p className="muted small-note">مقاسات نفدت من المحل والمستودع معاً.</p>
                {restock.length === 0 ? <p className="muted">لا يوجد: كل المقاسات متوفرة في موقع واحد على الأقل.</p> : (
                  <ul className="attn-list">
                    {restock.map((m) => (
                      <li key={m.modelNumber}>
                        <Link to={`/models/${m.modelNumber}`}><span className="mono strong">{m.modelNumber}</span> {m.name}</Link>
                        <span>{m.restockSizes.map((s) => <span key={s} className="size-chip danger">{s}</span>)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="جاهزة للنقل من المستودع" count={d.counts.transfer} tone="info">
                <p className="muted small-note">متوفرة في المستودع وغائبة عن المحل.</p>
                {transfer.length === 0 ? <p className="muted">لا يوجد.</p> : (
                  <ul className="attn-list">
                    {transfer.map((m) => (
                      <li key={m.modelNumber}>
                        <Link to={`/models/${m.modelNumber}`}><span className="mono strong">{m.modelNumber}</span> {m.name}</Link>
                        <span>{m.transferSizes.map((s) => <span key={s.size} className="size-chip">{s.size} ({s.warehouseQty})</span>)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="آخر الحركات">
                {d.recent.length === 0 ? <p className="muted">لا توجد حركات.</p> : (
                  <ul className="attn-list">
                    {d.recent.map((r) => (
                      <li key={r._id}>
                        <span><span className={`pill mv-${r.type}`}>{MOVEMENT_LABEL[r.type]}</span> <span className="mono">{r.modelNumber || r.name}</span> · {r.size}</span>
                        <span className="muted small-note">{fmtDateTime(r.createdAt)}</span>
                      </li>
                    ))}
                    <li><Link to="/movements">عرض السجل كاملاً ←</Link></li>
                  </ul>
                )}
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
