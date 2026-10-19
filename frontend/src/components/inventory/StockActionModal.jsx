import { useState } from "react";
import { api } from "../../api.js";
import Modal from "../ui/Modal.jsx";
import Field from "../ui/Field.jsx";
import { ErrorBanner } from "../ui/feedback.jsx";

const PLACE = { shop: "المحل", warehouse: "المستودع" };
const qtyAt = (s, loc) => (loc === "shop" ? s.shopQty : s.warehouseQty);

// mode: transfer | damage | adjust. كلها تمرّ على API واحد لكل عملية (لا منطق مكرر في الواجهة)
export default function StockActionModal({ model, mode, size: preSize, onClose, onDone }) {
  const [from, setFrom] = useState("warehouse");
  const [picks, setPicks] = useState(() => (preSize && mode === "transfer" ? { [preSize]: "1" } : {}));
  const [size, setSize] = useState(preSize || model.sizes[0]?.size || "");
  const [loc, setLoc] = useState("shop");
  const [qty, setQty] = useState("1");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const to = from === "shop" ? "warehouse" : "shop";
  const current = model.sizes.find((s) => s.size === size);

  const titles = { transfer: "نقل بين المستودع والمحل", damage: "تسجيل قطع تالفة", adjust: "جرد فعلي (تعديل الكمية)" };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const num = (v) => (v === "" ? NaN : Number(v));
    try {
      let res;
      if (mode === "transfer") {
        const items = Object.entries(picks).map(([s, q]) => ({ size: s, qty: num(q) })).filter((i) => i.qty > 0);
        if (!items.length) throw new Error("حدّد كمية لمقاس واحد على الأقل.");
        if (items.some((i) => !Number.isInteger(i.qty))) throw new Error("الكمية يجب أن تكون عدداً صحيحاً.");
        setSaving(true);
        res = await api.post("/stock/transfer", { modelNumber: model.modelNumber, from, to, items });
      } else if (mode === "damage") {
        if (!Number.isInteger(num(qty)) || num(qty) < 1) throw new Error("عدد القطع التالفة يجب أن يكون عدداً صحيحاً موجباً.");
        setSaving(true);
        res = await api.post("/stock/damage", { modelNumber: model.modelNumber, size, location: loc, qty: num(qty), reason });
      } else {
        const value = counted === "" ? qtyAt(current, loc) : num(counted);
        if (!Number.isInteger(value) || value < 0) throw new Error("الكمية الفعلية يجب أن تكون عدداً صحيحاً لا يقل عن صفر.");
        setSaving(true);
        res = await api.post("/stock/adjust", { modelNumber: model.modelNumber, size, location: loc, newQty: value, reason });
      }
      onDone(res.model);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`${titles[mode]} · ${model.modelNumber}`} onClose={onClose} wide={mode === "transfer"}>
      <form onSubmit={submit} className="form" noValidate>
        {mode === "transfer" && (
          <>
            <div className="seg" role="group" aria-label="اتجاه النقل">
              <button type="button" className={from === "warehouse" ? "on" : ""} onClick={() => { setFrom("warehouse"); setPicks({}); }}>المستودع ← المحل</button>
              <button type="button" className={from === "shop" ? "on" : ""} onClick={() => { setFrom("shop"); setPicks({}); }}>المحل ← المستودع</button>
            </div>
            <div className="table-wrap">
              <table className="table-cards">
                <thead><tr><th>المقاس</th><th className="num">المتوفر في {PLACE[from]}</th><th className="num">الكمية المنقولة</th></tr></thead>
                <tbody>
                  {model.sizes.map((s) => (
                    <tr key={s.size}>
                      <th scope="row" data-label="المقاس"><span className="size-chip">{s.size}</span></th>
                      <td className="num" data-label={`المتوفر في ${PLACE[from]}`}>{qtyAt(s, from)}</td>
                      <td className="num" data-label="الكمية المنقولة">
                        <input type="number" min="0" max={qtyAt(s, from)} step="1" disabled={qtyAt(s, from) === 0} aria-label={`كمية المقاس ${s.size}`}
                          value={picks[s.size] ?? ""} onChange={(e) => setPicks({ ...picks, [s.size]: e.target.value })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small-note">ينقص {PLACE[from]} ويزيد {PLACE[to]} بنفس الكمية في عملية واحدة، ولا يتغير الإجمالي.</p>
          </>
        )}

        {(mode === "damage" || mode === "adjust") && (
          <>
            <div className="grid2">
              <Field label="المقاس">
                <select value={size} onChange={(e) => { setSize(e.target.value); setCounted(""); }}>
                  {model.sizes.map((s) => <option key={s.size} value={s.size}>{s.size} (محل {s.shopQty} / مستودع {s.warehouseQty})</option>)}
                </select>
              </Field>
              <Field label="الموقع">
                <select value={loc} onChange={(e) => { setLoc(e.target.value); setCounted(""); }}>
                  <option value="shop">المحل</option>
                  <option value="warehouse">المستودع</option>
                </select>
              </Field>
            </div>
            {mode === "damage" ? (
              <Field label="عدد القطع التالفة" hint={`المتوفر في ${PLACE[loc]}: ${current ? qtyAt(current, loc) : 0}`}>
                <input type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
            ) : (
              <Field label="الكمية الفعلية بعد العدّ" hint={`المسجّل حالياً في ${PLACE[loc]}: ${current ? qtyAt(current, loc) : 0}`}>
                <input type="number" min="0" step="1" value={counted === "" ? (current ? qtyAt(current, loc) : 0) : counted} onChange={(e) => setCounted(e.target.value)} />
              </Field>
            )}
            <Field label="السبب (إلزامي)">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === "damage" ? "تمزّق، بقعة، تلف أثناء النقل..." : "جرد نهاية الشهر..."} />
            </Field>
            {mode === "damage" && <p className="muted small-note">القطع التالفة تُخصم من المخزون وتُحتسب خسارة بسعر الجملة في التقارير.</p>}
          </>
        )}

        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn primary" disabled={saving}>{saving ? "جارٍ الحفظ..." : "تأكيد"}</button>
        </div>
      </form>
    </Modal>
  );
}
