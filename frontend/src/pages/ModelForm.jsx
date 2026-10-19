import PageHeader from "../components/ui/PageHeader.jsx";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import Field from "../components/ui/Field.jsx";
import { Loading, ErrorBanner } from "../components/ui/feedback.jsx";
import SeriesBuilder, { newSeries, seriesError, seriesSizes } from "../components/inventory/SeriesBuilder.jsx";

const PRESETS = ["XS", "S", "M", "L", "XL", "XXL"];
const SIZE_RE = /^[A-Z0-9][A-Z0-9./-]{0,9}$/;

// إنشاء موديل جديد (مع أرتال افتتاحية اختيارية) أو تعديل بياناته. رقم الموديل ثابت بعد الإنشاء
export default function ModelForm({ mode }) {
  const { modelNumber } = useParams();
  const editing = mode === "edit";
  const existing = useAsync(() => (editing ? api.get(`/models/${modelNumber}`) : Promise.resolve(null)), [modelNumber, editing]);
  if (editing && existing.loading) return <Loading />;
  if (editing && existing.error) return <ErrorBanner error={existing.error} onRetry={existing.reload} />;
  return <Form editing={editing} model={existing.data} />;
}

function Form({ editing, model }) {
  const nav = useNavigate();
  const facets = useAsync(() => api.get("/models/facets"), []);
  const [f, setF] = useState({
    modelNumber: "", name: model?.name || "", brand: model?.brand || "", origin: model?.origin || "local", type: model?.type || "",
    cut: model?.cut || "", season: model?.season || "", notes: model?.notes || "", costPrice: model?.costPrice ?? "", sellPrice: model?.sellPrice ?? "",
  });
  const [sizes, setSizes] = useState(() => (model ? [] : ["S", "M", "L", "XL"].map((s) => ({ size: s, barcode: "" }))));
  const [opening, setOpening] = useState([]); // أرتال افتتاحية (اختيارية)
  const [showSeriesErrors, setShowSeriesErrors] = useState(false);
  const [remove, setRemove] = useState([]);
  const [custom, setCustom] = useState("");
  const [errors, setErrors] = useState({});
  const [apiError, setApiError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const toggle = (s) => setSizes((cur) => (cur.some((x) => x.size === s) ? cur.filter((x) => x.size !== s) : [...cur, { size: s, barcode: "" }]));
  const addCustom = () => {
    const s = custom.trim().toUpperCase().replace(/\s+/g, "");
    if (!SIZE_RE.test(s)) return setErrors({ ...errors, custom: "مقاس غير صالح (مثل 38 أو 2XL)" });
    if (sizes.some((x) => x.size === s) || model?.sizes.some((x) => x.size === s)) return setErrors({ ...errors, custom: "المقاس موجود" });
    setSizes([...sizes, { size: s, barcode: "" }]);
    setCustom("");
    setErrors({ ...errors, custom: undefined });
  };
  const suggest = async () => {
    if (!f.brand.trim()) return setErrors({ ...errors, modelNumber: "اكتب البراند أولاً لاقتراح رقم" });
    const r = await api.get(`/models/next-number?brand=${encodeURIComponent(f.brand)}`).catch(() => null);
    if (r) setF({ ...f, modelNumber: r.modelNumber });
  };

  const validate = () => {
    const e = {};
    if (!f.name.trim()) e.name = "اسم الموديل مطلوب";
    if (!f.brand.trim()) e.brand = "البراند مطلوب";
    if (!f.type.trim()) e.type = "نوع المنتج مطلوب";
    for (const k of ["costPrice", "sellPrice"]) if (f[k] === "" || Number(f[k]) < 0 || Number.isNaN(Number(f[k]))) e[k] = "أدخل سعراً صحيحاً (0 أو أكثر)";
    if (!editing) {
      if (sizes.length === 0) e.sizes = "حدّد مقاساً واحداً على الأقل";
      const badSeries = opening.map((o) => seriesError(o)).findIndex(Boolean);
      if (badSeries >= 0) e.opening = `الرتل الافتتاحي ${badSeries + 1}: ${seriesError(opening[badSeries])}`;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    setApiError(null);
    setShowSeriesErrors(true);
    if (!validate()) return;
    setSaving(true);
    try {
      const base = { name: f.name, brand: f.brand, origin: f.origin, type: f.type, cut: f.cut, season: f.season, notes: f.notes, costPrice: Number(f.costPrice), sellPrice: Number(f.sellPrice) };
      let saved;
      if (editing) {
        saved = await api.put(`/models/${model.modelNumber}`, {
          ...base,
          ...(sizes.length ? { addSizes: sizes.map((s) => ({ size: s.size })) } : {}),
          ...(remove.length ? { removeSizes: remove } : {}),
        });
      } else {
        saved = await api.post("/models", {
          ...base,
          ...(f.modelNumber.trim() ? { modelNumber: f.modelNumber.trim() } : {}),
          sizes: sizes.map((s) => ({ size: s.size, ...(s.barcode.trim() ? { barcode: s.barcode.trim() } : {}) })),
          ...(opening.length ? { openingSeries: opening.map((o) => ({ location: o.location, sizes: seriesSizes(o) })) } : {}),
        });
      }
      nav(`/models/${saved.modelNumber}`);
    } catch (err) {
      setApiError(err);
      const fe = {};
      (err.errors || []).forEach((x) => (fe[x.field] = x.message));
      setErrors((cur) => ({ ...cur, ...fe, ...(err.code === "MODEL_NUMBER_TAKEN" ? { modelNumber: err.message } : {}) }));
    } finally {
      setSaving(false);
    }
  };

  const types = facets.data?.types || [];
  const brands = facets.data?.brands || [];
  const cuts = facets.data?.cuts || [];

  return (
    <div>
      <div className="breadcrumb"><Link to="/models">الموديلات</Link> / {editing ? <Link to={`/models/${model.modelNumber}`} className="mono">{model.modelNumber}</Link> : "جديد"}</div>
      <PageHeader crumbs={[{ to: "/models", label: "الموديلات" }, { label: editing ? model.modelNumber : "جديد" }]} title={editing ? `تعديل ${model.modelNumber}` : "موديل جديد"} />
      <form className="form card" onSubmit={submit} noValidate>
        <ErrorBanner error={apiError} />
        <div className="grid3">
          <Field label="رقم الموديل" error={errors.modelNumber} hint={editing ? "ثابت ولا يُغيَّر (يعتمد عليه QR والفواتير)" : "اتركه فارغاً ليُولَّد تلقائياً، أو اكتب رقم الملصق الفعلي"}>
            <div className="input-row">
              <input className="mono" dir="ltr" value={editing ? model.modelNumber : f.modelNumber} onChange={set("modelNumber")} disabled={editing} placeholder="FAF-001" />
              {!editing && <button type="button" className="btn small ghost" onClick={suggest}>اقتراح</button>}
            </div>
          </Field>
          <Field label="اسم الموديل" error={errors.name}><input value={f.name} onChange={set("name")} placeholder="FAF Bootcut Trousers" /></Field>
          <Field label="البراند" error={errors.brand}>
            <input value={f.brand} onChange={set("brand")} list="brands" placeholder="FAF" />
            <datalist id="brands">{brands.map((b) => <option key={b} value={b} />)}</datalist>
          </Field>
          <Field label="الأصل"><select value={f.origin} onChange={set("origin")}><option value="local">وطني</option><option value="foreign">أجنبي</option></select></Field>
          <Field label="نوع المنتج" error={errors.type}>
            <input value={f.type} onChange={set("type")} list="types" placeholder="بنطال، قميص، جاكيت، فستان" />
            <datalist id="types">{types.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="القَصّة (اختياري)">
            <input value={f.cut} onChange={set("cut")} list="cuts" placeholder="بوت كات، بوي فريند، سكيني، أوفر سايز" />
            <datalist id="cuts">{cuts.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="سعر الجملة (USD)" error={errors.costPrice}><input type="number" min="0" step="0.01" value={f.costPrice} onChange={set("costPrice")} /></Field>
          <Field label="سعر البيع (USD)" error={errors.sellPrice}><input type="number" min="0" step="0.01" value={f.sellPrice} onChange={set("sellPrice")} /></Field>
          <Field label="الموسم (اختياري)"><input value={f.season} onChange={set("season")} placeholder="صيف 2026" /></Field>
        </div>
        <Field label="ملاحظات (اختياري)"><input value={f.notes} onChange={set("notes")} /></Field>

        <fieldset className="sizes-set">
          <legend>المقاسات {editing ? "" : "والباركود"}</legend>
          {editing && (
            <div className="chips">
              {model.sizes.map((s) => {
                const removable = s.totalQty === 0;
                const marked = remove.includes(s.size);
                return (
                  <span key={s.size} className={`size-chip ${marked ? "danger" : ""}`}>
                    {s.size} <small>{s.totalQty}</small>
                    {removable && <button type="button" className="chip-x" aria-label={marked ? `إلغاء حذف ${s.size}` : `حذف المقاس ${s.size}`} onClick={() => setRemove(marked ? remove.filter((x) => x !== s.size) : [...remove, s.size])}>{marked ? "↺" : "✕"}</button>}
                  </span>
                );
              })}
              <span className="muted small-note">يمكن حذف المقاس فقط إذا كان مخزونه صفراً.</span>
            </div>
          )}
          <div className="chips preset-row" role="group" aria-label="إضافة مقاسات">
            {PRESETS.filter((p) => !model?.sizes.some((s) => s.size === p)).map((p) => (
              <button type="button" key={p} className={`size-chip toggle ${sizes.some((s) => s.size === p) ? "on" : ""}`} aria-pressed={sizes.some((s) => s.size === p)} onClick={() => toggle(p)}>{p}</button>
            ))}
            <span className="input-row inline">
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="مقاس آخر (38، 2XL)" aria-label="مقاس مخصص" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustom())} />
              <button type="button" className="btn small" onClick={addCustom}>إضافة</button>
            </span>
          </div>
          {errors.custom && <span className="field-error" role="alert">{errors.custom}</span>}
          {errors.sizes && <span className="field-error" role="alert">{errors.sizes}</span>}

          {!editing && sizes.length > 0 && (
            <div className="table-wrap">
              <table className="table-cards">
                <thead><tr><th>المقاس</th><th>باركود المقاس (اختياري)</th><th /></tr></thead>
                <tbody>
                  {sizes.map((s, i) => (
                    <tr key={s.size}>
                      <th scope="row" data-label="المقاس"><span className="size-chip">{s.size}</span></th>
                      <td data-label="الباركود"><input dir="ltr" className="mono" value={s.barcode} placeholder="فارغ = يُولَّد داخلياً" onChange={(e) => setSizes(sizes.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} /></td>
                      <td><button type="button" className="icon-btn" aria-label={`إزالة ${s.size}`} onClick={() => setSizes(sizes.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>

        {!editing && (
          <fieldset className="sizes-set">
            <legend>الرصيد الافتتاحي (أرتال)</legend>
            {opening.length === 0 ? (
              <>
                <p className="muted small-note">اختياري: سجّل ما تملكه الآن على شكل أرتال (قطعة أو قطعتان من كل مقاس في الرتل). يمكنك أيضاً تركه فارغاً واستلام شحنة لاحقاً.</p>
                <button type="button" className="btn small" onClick={() => setOpening([newSeries("warehouse")])}>+ إضافة رتل افتتاحي</button>
              </>
            ) : (
              <>
                <SeriesBuilder sizes={sizes.map((x) => x.size)} value={opening} onChange={setOpening} withLocation onAddSize={(sz) => setSizes((cur) => [...cur, { size: sz, barcode: "" }])} showErrors={showSeriesErrors} />
                <button type="button" className="btn small ghost" onClick={() => setOpening([])}>إلغاء الرصيد الافتتاحي</button>
              </>
            )}
            {errors.opening && <span className="field-error" role="alert">{errors.opening}</span>}
          </fieldset>
        )}

        <div className="actions">
          <Link className="btn ghost" to={editing ? `/models/${model.modelNumber}` : "/models"}>إلغاء</Link>
          <button className="btn primary" disabled={saving}>{saving ? "جارٍ الحفظ..." : editing ? "حفظ التعديلات" : "إنشاء الموديل"}</button>
        </div>
      </form>
    </div>
  );
}
