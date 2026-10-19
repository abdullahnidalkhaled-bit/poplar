import PageHeader from "../components/ui/PageHeader.jsx";
import { useRef, useState } from "react";
import { api } from "../api.js";

export default function Settings({ settings, onSaved }) {
  const [rate, setRate] = useState(settings?.usdToSyp ?? 0);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  const save = async (e) => {
    e.preventDefault();
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      const s = await api.put("/settings", { usdToSyp: Number(rate) });
      onSaved(s);
      setMsg({ type: "ok", text: "تم حفظ الإعدادات." });
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="الإعدادات" />
      <form className="form card narrow" onSubmit={save}>
        <label>
          سعر الصرف: كم ليرة سورية تساوي 1 دولار؟
          <input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
          <span className="muted small-note">
            يُستخدم عند البيع بالليرة. كل فاتورة تحفظ سعر الصرف وقت بيعها، فتغيير السعر لا يؤثر على الفواتير القديمة.
          </span>
        </label>
        {msg && <div className={`banner ${msg.type}`}>{msg.text}</div>}
        <div className="actions"><button className="btn primary" disabled={busy}>{busy ? "جارٍ الحفظ..." : "حفظ"}</button></div>
      </form>
    </div>
  );
}
