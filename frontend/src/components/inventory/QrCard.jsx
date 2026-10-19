import { useState } from "react";
import { api } from "../../api.js";
import useAsync from "../../hooks/useAsync.js";
import { Loading, ErrorBanner } from "../ui/feedback.jsx";

// ملصق QR للموديل: يُطبع ويُلصق، ومسحه يفتح بيانات الموديل. الحمولة لا تحتوي بيانات حساسة
export default function QrCard({ modelNumber }) {
  const { data, error, loading } = useAsync(() => api.get(`/models/${encodeURIComponent(modelNumber)}/qr`), [modelNumber]);
  const [copied, setCopied] = useState(false);

  if (loading) return <Loading label="جارٍ توليد QR..." />;
  if (error) return <ErrorBanner error={error} />;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* النسخ اختياري */ }
  };

  return (
    <div className="qr-card">
      <div className="qr-printable">
        <div className="qr-svg" role="img" aria-label={`رمز QR للموديل ${data.modelNumber}`} dangerouslySetInnerHTML={{ __html: data.svg }} />
        <div className="qr-caption mono strong">{data.modelNumber}</div>
        <div className="qr-caption small">{data.name}</div>
      </div>
      <div className="qr-actions">
        <button className="btn small" onClick={() => window.print()}>طباعة الملصق</button>
        <button className="btn small ghost" onClick={copy}>{copied ? "تم النسخ ✔" : "نسخ الرمز"}</button>
      </div>
      <p className="muted small-note mono" dir="ltr">{data.payload}</p>
    </div>
  );
}
