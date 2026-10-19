import StatCard from "../ui/StatCard.jsx";
import { useAuth } from "../../auth.jsx";
import { Alert } from "../ui/feedback.jsx";
import SizeTable from "./SizeTable.jsx";
import { ORIGIN_LABEL, usd } from "../../utils.js";

// نظرة شاملة على موديل: بيانات + مجاميع + تنبيهات + جدول المقاسات.
// تُستخدم في صفحة التفاصيل وفي نتيجة مسح QR (نفس المكوّن = نفس السلوك)
export default function ModelOverview({ model, highlight, renderActions, onTransferAll }) {
  const m = model;
  const { can } = useAuth();
  return (
    <div className="overview">
      <dl className="meta-grid">
        <div><dt>رقم الموديل</dt><dd className="mono strong">{m.modelNumber}</dd></div>
        <div><dt>الاسم</dt><dd>{m.name}</dd></div>
        <div><dt>البراند</dt><dd>{m.brand} <span className={`pill ${m.origin}`}>{ORIGIN_LABEL[m.origin]}</span></dd></div>
        <div><dt>النوع</dt><dd>{m.type}</dd></div>
        <div><dt>القَصّة</dt><dd>{m.cut || "—"}</dd></div>
        <div><dt>الموسم</dt><dd>{m.season || "—"}</dd></div>
        {can("costs.view") && <div><dt>سعر الجملة</dt><dd>{usd(m.costPrice)}</dd></div>}
        <div><dt>سعر البيع</dt><dd>{usd(m.sellPrice)}</dd></div>
        {m.notes && <div className="wide"><dt>ملاحظات</dt><dd>{m.notes}</dd></div>}
      </dl>

      <div className="stats compact">
        <StatCard label="في المحل" value={m.totals.shop} />
        <StatCard label="في المستودع" value={m.totals.warehouse} />
        <StatCard label="الإجمالي" value={m.totals.combined} />
        <StatCard label="مقاسات نفدت" value={m.restockSizes.length} tone={m.restockSizes.length ? "loss" : ""} hint={m.restockSizes.join("، ")} />
      </div>

      {m.restockSizes.length > 0 && (
        <Alert tone="danger" title={`نفدت المقاسات: ${m.restockSizes.join("، ")}`}>
          هذا المقاس نفد من المخزون. تواصل مع المصنع لطلب إعادة التوريد.
        </Alert>
      )}
      {m.transferableSizes.length > 0 && (
        <Alert
          tone="info"
          title={`متوفرة في المستودع وغائبة عن المحل: ${m.transferableSizes.join("، ")}`}
          action={onTransferAll && <button className="btn small" onClick={onTransferAll}>نقل إلى المحل</button>}
        >
          يمكن نقلها إلى المحل للعرض والبيع، ولا حاجة لطلبها من المصنع.
        </Alert>
      )}

      <SizeTable sizes={m.sizes} highlight={highlight} renderActions={renderActions} />
    </div>
  );
}
