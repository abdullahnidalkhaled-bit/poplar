import { useState } from "react";
import { compareSizes } from "../../utils.js";

const SIZE_RE = /^[A-Z0-9][A-Z0-9./-]{0,9}$/;
let uid = 0;
export const newSeries = (location) => ({ id: ++uid, qtys: {}, ...(location ? { location } : {}) });

// ما يُرسل للخادم: المقاسات المشمولة فقط (1 أو 2). غير المشمولة لا تُرسل ولا تُعامل كمخزون
export const seriesSizes = (s) =>
  Object.entries(s.qtys).filter(([, q]) => q !== "" && q != null && Number(q) > 0).map(([size, q]) => ({ size, qty: Number(q) }));

// فحص واجهة فقط (الخادم هو المرجع): القاعدة نفسها 1 أو 2 لكل مقاس ورتل غير فارغ
export function seriesError(s) {
  const sizes = seriesSizes(s);
  if (!sizes.length) return "الرتل فارغ: اختر قطعة أو قطعتين لمقاس واحد على الأقل.";
  const bad = sizes.find((x) => !Number.isInteger(x.qty) || x.qty > 2);
  return bad ? `المقاس ${bad.size}: الحد الأقصى قطعتان في الرتل الواحد.` : "";
}

const total = (s) => seriesSizes(s).reduce((n, x) => n + x.qty, 0);

// منشئ الأرتال: كل رتل شبكة مقاسات (— / 1 / 2). يُستخدم في الاستلام والرصيد الافتتاحي
export default function SeriesBuilder({ sizes, value, onChange, withLocation = false, onAddSize, showErrors = false }) {
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState("");
  const ordered = [...sizes].sort(compareSizes);

  const patch = (id, fn) => onChange(value.map((s) => (s.id === id ? fn(s) : s)));
  const setQty = (id, size, q) => patch(id, (s) => ({ ...s, qtys: { ...s.qtys, [size]: q } }));
  const addCustom = () => {
    const s = custom.trim().toUpperCase().replace(/\s+/g, "");
    if (!SIZE_RE.test(s)) return setCustomError("مقاس غير صالح (مثل 38 أو 2XL).");
    if (sizes.includes(s)) return setCustomError("هذا المقاس موجود.");
    onAddSize(s);
    setCustom("");
    setCustomError("");
  };

  return (
    <div className="series-builder">
      {value.map((s, i) => {
        const err = showErrors ? seriesError(s) : "";
        return (
          <fieldset key={s.id} className="series-card">
            <legend>رتل {i + 1} · {total(s)} قطعة</legend>
            <div className="series-grid" role="group" aria-label={`مقاسات الرتل ${i + 1}`}>
              {ordered.map((size) => (
                <label key={size} className="series-cell">
                  <span className="size-chip">{size}</span>
                  <select value={s.qtys[size] ?? ""} onChange={(e) => setQty(s.id, size, e.target.value)} aria-label={`كمية المقاس ${size} في الرتل ${i + 1}`}>
                    <option value="">—</option><option value="1">1</option><option value="2">2</option>
                  </select>
                </label>
              ))}
            </div>
            <div className="series-foot">
              {withLocation && (
                <select value={s.location} onChange={(e) => patch(s.id, (x) => ({ ...x, location: e.target.value }))} aria-label={`موقع الرتل ${i + 1}`}>
                  <option value="shop">المحل</option><option value="warehouse">المستودع</option>
                </select>
              )}
              {value.length > 1 && <button type="button" className="btn small ghost" onClick={() => onChange(value.filter((x) => x.id !== s.id))}>حذف الرتل</button>}
            </div>
            {err && <div className="field-error" role="alert">{err}</div>}
          </fieldset>
        );
      })}
      <div className="input-row inline">
        <button type="button" className="btn small" onClick={() => onChange([...value, newSeries(withLocation ? value[value.length - 1]?.location || "warehouse" : undefined)])}>+ رتل آخر</button>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="مقاس جديد (38، 2XL)" aria-label="مقاس جديد" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())} />
        <button type="button" className="btn small" onClick={addCustom}>إضافة مقاس</button>
      </div>
      {customError && <div className="field-error" role="alert">{customError}</div>}
      <p className="muted small-note">كل مقاس في الرتل الواحد: قطعة أو قطعتان فقط. المقاسات التي لا تختارها لا تُحسب ضمن الرتل. يمكنك تسجيل عدة أرتال لنفس الموديل.</p>
    </div>
  );
}
