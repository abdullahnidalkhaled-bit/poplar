import { useState } from "react";
import { api } from "../api.js";
import Modal from "./ui/Modal.jsx";
import { money, usd, variantLabel, invNo, num } from "../utils.js";

export default function ReturnModal({ invoice, rate, onClose, onDone, onStartExchange }) {
  const [picks, setPicks] = useState({});
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("cash");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const avail = (it) => it.qty - (it.returnedQty || 0);
  const setPick = (i, patch) =>
    setPicks({ ...picks, [i]: { qty: 0, condition: "good", ...picks[i], ...patch } });

  const chosen = invoice.items
    .map((it, i) => ({ it, i, p: picks[i] }))
    .filter((x) => x.p && Number(x.p.qty) > 0);
  const refundAmount = chosen.reduce((s, x) => s + x.it.unitPrice * Number(x.p.qty), 0);
  // unitPriceUsd لا يصل للموظف: ملاحظات الصرف بالدولار عرض للمالك فقط، والحساب الفعلي كله على الخادم
  const hasUsd = invoice.items.every((it) => it.unitPriceUsd != null);
  const refundUsdOrig = hasUsd ? chosen.reduce((s, x) => s + x.it.unitPriceUsd * Number(x.p.qty), 0) : 0;
  const isSyp = invoice.currency === "SYP";
  const todayUsd = isSyp && rate > 0 ? refundAmount / rate : refundAmount;
  const fx = todayUsd - refundUsdOrig;
  const items = chosen.map((x) => ({ itemIndex: x.i, qty: Number(x.p.qty), condition: x.p.condition }));

  const submit = async () => {
    setError("");
    if (items.length === 0) return setError("اختر قطعة واحدة على الأقل وحدّد كميتها.");
    if (isSyp && !(rate > 0)) return setError("حدّد سعر الصرف من الإعدادات أولاً.");
    if (mode === "exchange") {
      return onStartExchange({
        invoice, items, reason,
        creditAmount: refundAmount, creditCurrency: invoice.currency, creditUsd: refundUsdOrig,
      });
    }
    setSaving(true);
    try {
      const res = await api.post("/returns", { invoiceId: invoice._id, items, reason, mode: "cash" });
      onDone(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`إرجاع / تبديل · الفاتورة ${invNo(invoice.number)}`} onClose={onClose} wide>
      <div className="form">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>القطعة</th><th>سعر الدفع</th><th>المتاح للإرجاع</th><th>الكمية</th><th>حالة القطعة</th></tr>
            </thead>
            <tbody>
              {invoice.items.map((it, i) => (
                <tr key={i}>
                  <td><b>{it.brand}</b> {it.name} · {variantLabel(it)}</td>
                  <td>{money(it.unitPrice, invoice.currency)}</td>
                  <td>{avail(it)}</td>
                  <td>
                    <input
                      type="number" min="0" max={avail(it)} style={{ width: 72 }}
                      disabled={avail(it) === 0}
                      value={picks[i]?.qty ?? 0}
                      onChange={(e) => setPick(i, { qty: Math.max(0, Math.min(avail(it), Number(e.target.value) || 0)) })}
                    />
                  </td>
                  <td>
                    <select disabled={avail(it) === 0} value={picks[i]?.condition || "good"} onChange={(e) => setPick(i, { condition: e.target.value })}>
                      <option value="good">سليمة (تعود للمحل)</option>
                      <option value="damaged">تالفة (لا تعود)</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <label>
          سبب الإرجاع (اختياري)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مقاس غير مناسب، تبديل، عيب..." />
        </label>

        <div className="seg" role="group" aria-label="نوع العملية">
          <button type="button" className={mode === "cash" ? "on" : ""} onClick={() => setMode("cash")}>استرداد نقدي</button>
          <button type="button" className={mode === "exchange" ? "on" : ""} onClick={() => setMode("exchange")}>تبديل بقطعة أخرى</button>
        </div>

        <div className="refund-box">
          <div>
            <div className="muted">قيمة المرتجع (بما دفعته الزبونة فعلاً)</div>
            <div className="refund-value">{money(refundAmount, invoice.currency)}</div>
            {isSyp && hasUsd && <div className="muted small-note">= {usd(refundUsdOrig)} بسعر الصرف وقت البيع ({invoice.rate.toLocaleString("en-US")})</div>}
          </div>
          {isSyp && hasUsd && rate > 0 && refundAmount > 0 && (
            <div className={`fx-note ${fx > 0.004 ? "loss" : fx < -0.004 ? "gain" : ""}`}>
              بسعر اليوم ({rate.toLocaleString("en-US")}) قيمته {usd(todayUsd)}.
              {Math.abs(fx) < 0.005
                ? " لا فرق صرف."
                : fx > 0
                ? ` فرق الصرف ${usd(fx)} خسارة تُسجَّل على المتجر.`
                : ` فرق الصرف ${usd(-fx)} ربح يُسجَّل للمتجر.`}
            </div>
          )}
        </div>
        <p className="muted small-note">
          يُردّ المبلغ بعملة الدفع الأصلية، ويُعكس ربح الفاتورة الأصلية بقيمها وقت البيع. القطعة البديلة تُباع بسعر اليوم.
        </p>

        {error && <div className="banner error">{error}</div>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button type="button" className="btn primary" onClick={submit} disabled={saving}>
            {mode === "exchange" ? "متابعة لاختيار القطعة البديلة" : saving ? "جارٍ الحفظ..." : `تأكيد الإرجاع (${num(items.reduce((s, x) => s + x.qty, 0))} قطعة)`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
