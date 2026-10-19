import PageHeader from "../components/ui/PageHeader.jsx";
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { usd } from "../utils.js";

const Stat = ({ label, value, tone }) => (
  <div className={`stat ${tone || ""}`}>
    <div className="muted">{label}</div>
    <div className="stat-value">{value}</div>
  </div>
);

// تقارير المخزون فقط. التقارير المالية (إيراد، ربح، نقد، مصروفات) انتقلت إلى صفحة «المالية»
// حيث يُعرض كل صندوق (ليرة / دولار) في قسم مستقل بلا أي مجموع مشترك أو تحويل بين العملتين.
export default function Reports() {
  const { can } = useAuth();
  const [inv, setInv] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/reports/inventory").then(setInv).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <PageHeader title="التقارير" sub="حالة المخزون والتنبيهات" />
      {can("finance.manage") && (
        <div className="banner warn" role="status">
          <span>التقارير المالية (المبيعات، الربح، النقد، المصروفات) في صفحة <Link to="/finance"><b>المالية</b></Link>، بقسم مستقل لكل عملة ودون مجموع مختلط بين الليرة والدولار.</span>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {!inv && !error && <p className="muted">جارٍ التحميل...</p>}
      {inv && (
        <div className="card">
          <h3>المخزون الحالي</h3>
          <div className="stats compact">
            <Stat label="إجمالي القطع" value={`${inv.totals.pieces} (محل ${inv.totals.shopPieces} / مستودع ${inv.totals.warehousePieces})`} />
            <Stat label="قيمته بسعر الجملة (تكلفة المخزون بالدولار)" value={usd(inv.totals.costValueUsd)} />
            <Stat label="قيمته بسعر البيع (دولار)" value={usd(inv.totals.sellValueUsd)} />
          </div>
          <h4>تحتاج انتباهاً: نفدت من الموقعين (طلب شحنة) / جاهزة للنقل من المستودع</h4>
          {inv.attention.length === 0 ? <p className="muted">لا شيء يحتاج انتباهاً.</p> : (
            <table className="table-cards">
              <thead><tr><th>الموديل</th><th>نفدت (المصنع)</th><th>للنقل من المستودع</th></tr></thead>
              <tbody>
                {inv.attention.map((m) => (
                  <tr key={m.modelNumber}>
                    <td data-label="الموديل"><Link to={`/models/${m.modelNumber}`} className="mono strong">{m.modelNumber}</Link> {m.brand} {m.name}</td>
                    <td data-label="نفدت (المصنع)" className={m.restockSizes.length ? "loss-text" : ""}>{m.restockSizes.join("، ") || "—"}</td>
                    <td data-label="للنقل من المستودع">{m.transferSizes.map((x) => `${x.size} (${x.warehouseQty})`).join("، ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
