import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, qs } from "../api.js";
import { useAuth } from "../auth.jsx";
import useAsync from "../hooks/useAsync.js";
import ModelOverview from "../components/inventory/ModelOverview.jsx";
import QrCard from "../components/inventory/QrCard.jsx";
import StockActionModal from "../components/inventory/StockActionModal.jsx";
import PageHeader from "../components/ui/PageHeader.jsx";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import { Loading, ErrorBanner, Alert, EmptyState } from "../components/ui/feedback.jsx";
import { fmtDateTime, MOVEMENT_LABEL } from "../utils.js";

export default function ModelDetail() {
  const { modelNumber } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: model, error, loading, reload } = useAsync(() => api.get(`/models/${encodeURIComponent(modelNumber)}`), [modelNumber]);
  const recent = useAsync(() => (can("movements.read") ? api.get(`/movements${qs({ q: modelNumber, limit: 6 })}`) : Promise.resolve(null)), [modelNumber, model?.updatedAt]);
  const [action, setAction] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  if (loading && !model) return <Loading />;
  if (error) {
    return (
      <div>
        <ErrorBanner error={error} onRetry={reload} />
        {error.status === 404 && <EmptyState title="هذا الموديل غير موجود"><Link className="btn" to="/models">العودة إلى الموديلات</Link></EmptyState>}
      </div>
    );
  }

  const toggleActive = async () => {
    setBusy(true);
    setActionError(null);
    try {
      if (model.active) await api.del(`/models/${model.modelNumber}`);
      else await api.post(`/models/${model.modelNumber}/restore`);
      setConfirm(false);
      reload();
    } catch (e) {
      setActionError(e);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        crumbs={[{ to: "/models", label: "الموديلات" }, { label: model.modelNumber }]}
        title={`${model.brand} ${model.name}`}
        primary={can("stock.receive") && <Link className="btn primary" to={`/receive?model=${model.modelNumber}`}>استلام شحنة</Link>}
        more={[
          { label: "نقل بين المحل والمستودع", onClick: () => setAction({ mode: "transfer" }), hidden: !can("stock.transfer") },
          { label: "تسجيل تالف", onClick: () => setAction({ mode: "damage" }), hidden: !can("stock.damage") },
          { label: "جرد", onClick: () => setAction({ mode: "adjust" }), hidden: !can("stock.adjust") },
          { label: "تعديل البيانات", to: `/models/${model.modelNumber}/edit`, hidden: !can("models.manage") },
          { label: model.active ? "أرشفة الموديل" : "استعادة الموديل", onClick: () => setConfirm(true), danger: model.active, hidden: !can("models.manage") },
        ]}
      />

      {!model.active && <Alert tone="warn" title="هذا الموديل مؤرشف">لا يُباع ولا يُستلم، ورمز QR الخاص به لم يعد صالحاً. الفواتير والسجل القديم محفوظة.</Alert>}
      <ErrorBanner error={actionError} />

      <div className="detail-grid">
        <section className="card">
          <ModelOverview
            model={model}
            onTransferAll={can("stock.transfer") ? () => setAction({ mode: "transfer" }) : undefined}
            renderActions={(s) => s.canTransfer && can("stock.transfer") && <button className="btn small" onClick={() => setAction({ mode: "transfer", size: s.size })}>نقل للمحل</button>}
          />
        </section>
        <aside className="side-col">
          <section className="card"><h3>رمز QR</h3><QrCard modelNumber={model.modelNumber} /></section>
          <section className="card">
            <h3>آخر الحركات</h3>
            {recent.data?.items?.length ? (
              <ul className="attn-list">
                {recent.data.items.map((r) => (
                  <li key={r._id}>
                    <span><span className={`pill mv-${r.type}`}>{MOVEMENT_LABEL[r.type]}</span> {r.size} · {r.delta > 0 ? "+" : ""}{r.delta || r.qty}</span>
                    <span className="muted small-note">{fmtDateTime(r.createdAt)}</span>
                  </li>
                ))}
                <li><Link to={`/movements?q=${model.modelNumber}`}>كل حركات هذا الموديل ←</Link></li>
              </ul>
            ) : <p className="muted">لا توجد حركات.</p>}
          </section>
        </aside>
      </div>

      {action && (
        <StockActionModal model={model} mode={action.mode} size={action.size} onClose={() => setAction(null)} onDone={() => { setAction(null); reload(); }} />
      )}
      {confirm && (
        <ConfirmDialog
          title={model.active ? "أرشفة الموديل؟" : "استعادة الموديل؟"}
          message={model.active ? `سيتوقف بيع واستلام ${model.modelNumber} ويُبطَل رمز QR، وتبقى الفواتير والسجل. يمكنك استعادته لاحقاً.` : "سيعود الموديل للبيع والاستلام."}
          confirmLabel={model.active ? "أرشفة" : "استعادة"} danger={model.active} busy={busy} onConfirm={toggleActive} onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
