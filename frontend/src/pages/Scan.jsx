import PageHeader from "../components/ui/PageHeader.jsx";
import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api.js";
import QrScanner from "../components/qr/QrScanner.jsx";
import ModelOverview from "../components/inventory/ModelOverview.jsx";
import { Loading, ErrorBanner } from "../components/ui/feedback.jsx";

// مسح QR (كاميرا) أو إدخال رمز (جهاز ماسح يعمل كلوحة مفاتيح) أو رقم موديل: كلها عبر نقطة واحدة /lookup
export default function Scan() {
  const [camera, setCamera] = useState(false);
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const resolve = useCallback(async (raw) => {
    const value = String(raw || "").trim();
    if (!value) return;
    setLoading(true);
    try {
      setResult(await api.get(`/lookup${qs({ code: value })}`));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div>
      <PageHeader title="مسح QR" />
      <div className="scan-layout">
        <section className="card">
          <form className="search-bar" onSubmit={(e) => { e.preventDefault(); resolve(code); setCode(""); }} role="search">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="امسح بجهاز الماسح أو اكتب/الصق الرمز أو رقم الموديل" aria-label="الرمز" autoFocus autoComplete="off" dir="ltr" />
            <button className="btn primary">بحث</button>
          </form>
          <div className="scan-camera">
            {camera ? (
              <>
                <QrScanner onResult={(data) => { setCamera(false); resolve(data); }} />
                <button className="btn small ghost" onClick={() => setCamera(false)}>إيقاف الكاميرا</button>
              </>
            ) : (
              <button className="btn" onClick={() => setCamera(true)}>تشغيل الكاميرا للمسح</button>
            )}
          </div>
        </section>

        <section className="card result-col" aria-live="polite">
          {loading && <Loading />}
          <ErrorBanner error={error} />
          {!result && !error && !loading && <p className="muted">امسح رمز QR الملصق على القطعة لعرض بيانات الموديل والمخزون.</p>}
          {result && (
            <>
              <div className="page-head tight">
                <h2>{result.model.brand} {result.model.name}</h2>
                <Link className="btn small" to={`/models/${result.model.modelNumber}`}>فتح صفحة الموديل</Link>
              </div>
              {result.kind === "size" && <p className="muted">باركود مقاس: <b>{result.size.size}</b></p>}
              <ModelOverview model={result.model} highlight={result.size?.size} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
