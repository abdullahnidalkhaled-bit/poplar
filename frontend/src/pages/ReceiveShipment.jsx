import PageHeader from "../components/ui/PageHeader.jsx";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { api, qs } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import useDebounced from "../hooks/useDebounced.js";
import Field from "../components/ui/Field.jsx";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import { Loading, ErrorBanner, Alert } from "../components/ui/feedback.jsx";
import SeriesBuilder, { newSeries, seriesError, seriesSizes } from "../components/inventory/SeriesBuilder.jsx";
import { newKey, money } from "../utils.js";

const PAY_MODES = [
  ["unpaid", "غير مدفوعة", "تُسجَّل الفاتورة والتزام للتاجر، بلا حركة نقد."],
  ["paid", "مدفوعة بالكامل الآن", "تخرج القيمة كاملة من صندوق عملة الفاتورة."],
  ["partial", "مدفوعة جزئياً", "يخرج المبلغ المدفوع فقط ويبقى الباقي مستحقاً."],
  ["advance", "من سلفة قائمة", "تُخصَّص السلفة على الفاتورة؛ لا يخرج نقد جديد (خرج عند دفع السلفة)."],
];
const r2 = (n) => Math.round(n * 100) / 100;

// استلام شحنة لموديل واحد على شكل أرتال. للمالك: اختيار التاجر ينشئ فاتورة الشراء والدفع/السلفة في العملية نفسها
// (أو بضاعة أمانة بلا فاتورة ولا التزام). كل شيء يُحفظ معاً في الخادم أو لا يُحفظ شيء.
export default function ReceiveShipment() {
  const [sp, setSp] = useSearchParams();
  const mn = sp.get("model") || "";
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const found = useAsync(() => (dq.trim() ? api.get(`/models${qs({ q: dq, limit: 6 })}`) : Promise.resolve(null)), [dq]);
  const model = useAsync(() => (mn ? api.get(`/models/${encodeURIComponent(mn)}`) : Promise.resolve(null)), [mn]);

  const [series, setSeries] = useState(() => [newSeries()]);
  const [extra, setExtra] = useState([]);
  const [showErrors, setShowErrors] = useState(false);
  const [location, setLocation] = useState("warehouse");
  const { can } = useAuth();
  const canCost = can("costs.manage"); // الموظف يستلم الشحنة بلا تكلفة
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const canSuppliers = can("suppliers.manage"); // ملكية الشحنة والفاتورة للمالك فقط
  const suppliers = useAsync(() => (canSuppliers ? api.get("/suppliers?limit=100") : Promise.resolve(null)), [canSuppliers]);
  const [supplierId, setSupplierId] = useState("");
  const [consignment, setConsignment] = useState(false);
  const [price, setPrice] = useState({ amount: "", currency: "USD" });
  const [inv, setInv] = useState({ on: true, no: "", currency: "USD", amount: "", due: "" });
  const [pay, setPay] = useState({ mode: "unpaid", cash: "", adv: {} });
  const allocs = useAsync(() => (canSuppliers && supplierId ? api.get(`/suppliers/${supplierId}/allocations`) : Promise.resolve(null)), [canSuppliers, supplierId]);
  const [formError, setFormError] = useState("");
  const [apiError, setApiError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);
  const key = useRef(newKey()); // نفس المفتاح عند إعادة الإرسال = لا مضاعفة

  useEffect(() => {
    setSeries([newSeries()]); setExtra([]); setFormError(""); setApiError(null); setShowErrors(false);
    setCost(model.data && canCost ? String(model.data.costPrice) : "");
  }, [model.data?.modelNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  const sizes = [...(model.data?.sizes.map((s) => s.size) || []), ...extra];
  const payload = series.map((x) => ({ sizes: seriesSizes(x) }));
  const totalQty = payload.reduce((n, x) => n + x.sizes.reduce((m, y) => m + y.qty, 0), 0);

  const withInvoice = canSuppliers && !!supplierId && !consignment && inv.on;
  const suggested = canCost && cost !== "" && totalQty > 0 && inv.currency === "USD" ? r2(Number(cost) * totalQty) : null;
  const advCredits = (allocs.data?.credits || []).filter((c) => c.available > 0 && c.currency === inv.currency && (c.type === "advance" || c.type === "payment"));
  const total = Number(inv.amount) || 0;
  const cashNow = pay.mode === "paid" ? total : pay.mode === "partial" ? Number(pay.cash) || 0 : 0;
  const advPicks = pay.mode === "advance" ? advCredits.map((c) => ({ entryId: c.id, amount: Number(pay.adv[c.id]) || 0, available: c.available })).filter((x) => x.amount > 0) : [];
  const advNow = r2(advPicks.reduce((n, x) => n + x.amount, 0));
  const remaining = r2(total - cashNow - advNow);
  const supplierName = suppliers.data?.items?.find((x) => x.id === supplierId)?.name || "";

  const invError = () => {
    if (!withInvoice) return "";
    if (!inv.no.trim()) return "أدخل رقم فاتورة التاجر.";
    if (!(total > 0)) return "أدخل قيمة الفاتورة.";
    if (inv.currency === "SYP" && !Number.isInteger(total)) return "مبلغ الليرة عدد صحيح.";
    if (pay.mode === "partial" && !(cashNow > 0 && cashNow < total)) return "المبلغ المدفوع جزئياً يجب أن يكون أكبر من صفر وأقل من قيمة الفاتورة.";
    if (pay.mode === "advance") {
      if (!advPicks.length) return "اختر سلفة وأدخل المبلغ المخصَّص منها.";
      if (advPicks.some((x) => x.amount > x.available)) return "مبلغ مخصَّص يتجاوز المتاح في السلفة.";
      if (advNow > total) return "السلف المخصَّصة تتجاوز قيمة الفاتورة.";
    }
    return "";
  };

  const review = (e) => {
    e.preventDefault();
    setFormError(""); setApiError(null); setShowErrors(true);
    const bad = series.map((x) => seriesError(x)).findIndex(Boolean);
    if (bad >= 0) return setFormError(`الرتل ${bad + 1}: ${seriesError(series[bad])}`);
    if (consignment && !supplierId) return setFormError("بضاعة الأمانة تتطلب اختيار التاجر المالك.");
    if (consignment && price.amount !== "" && !(Number(price.amount) > 0)) return setFormError("سعر الاتفاق غير صالح.");
    const ie = invError();
    if (ie) return setFormError(ie);
    if (cost !== "" && (Number.isNaN(Number(cost)) || Number(cost) < 0)) return setFormError("سعر الجملة غير صالح.");
    setConfirm(true);
  };

  const submit = async () => {
    setSaving(true);
    try {
      const res = await api.post("/stock/receive", {
        modelNumber: model.data.modelNumber, series: payload, location, idempotencyKey: key.current, note,
        ...(canCost && cost !== "" ? { unitCostUsd: Number(cost) } : {}),
        ...(canSuppliers && supplierId ? { supplierId, consignment } : {}),
        ...(withInvoice
          ? {
              purchase: {
                invoiceNo: inv.no.trim(), currency: inv.currency, amount: total, ...(inv.due ? { dueDate: inv.due } : {}),
                ...(cashNow > 0 || advPicks.length
                  ? { payment: { ...(cashNow > 0 ? { cashAmount: cashNow } : {}), ...(advPicks.length ? { advances: advPicks.map((x) => ({ entryId: x.entryId, amount: x.amount })) } : {}) } }
                  : {}),
              },
            }
          : {}),
        ...(canSuppliers && consignment && price.amount !== "" ? { consignmentPrice: { amount: Number(price.amount), currency: price.currency } } : {}),
      });
      setDone({ ...res, supplierId, series: payload, location, total: totalQty, seriesList: (res.series || []).map((x) => x.seriesNo) });
      key.current = newKey(); // شحنة جديدة بعد النجاح
      setSeries([newSeries()]); setExtra([]); setNote(""); setShowErrors(false);
      setInv({ on: true, no: "", currency: inv.currency, amount: "", due: "" });
      setPay({ mode: "unpaid", cash: "", adv: {} });
      allocs.reload();
      model.reload();
    } catch (err) {
      setApiError(err);
    } finally {
      setSaving(false);
      setConfirm(false);
    }
  };

  const p = done?.purchase;
  return (
    <div>
      <PageHeader title="استلام شحنة" more={[{ label: "موديل جديد غير مسجّل", to: "/models/new", hidden: !can("models.manage") }]} />

      {done && (
        <Alert tone={done.duplicate ? "info" : "ok"} title={done.duplicate ? "هذه الشحنة سُجّلت مسبقاً" : "تم تسجيل الشحنة"}
          action={<Link className="btn small" to={`/models/${done.model.modelNumber}`}>عرض الموديل</Link>}>
          {p && !done.duplicate && (
            <div className="receipt-result">
              <span><b>الفاتورة {p.invoice.invoiceNo}</b> ({money(p.invoice.amount, p.invoice.currency)}) · الاستلام {p.shipmentRef}</span>
              <span>
                مدفوع نقداً الآن: {money(p.cashPaid, p.invoice.currency)}{p.paymentRef ? ` (${p.paymentRef})` : ""} · سلفة مخصَّصة: {money(p.advanceApplied, p.invoice.currency)} ·{" "}
                <b>المتبقي مستحق: {money(p.outstanding, p.invoice.currency)}</b>
              </span>
              {done.supplierId && <Link className="btn small ghost" to={`/suppliers/${done.supplierId}`}>عرض حساب التاجر</Link>}
            </div>
          )}
          {done.duplicate ? "لم تُضاف الكميات مرة ثانية." : `أُضيف ${done.series.length} رتل (${done.total} قطعة) إلى ${done.location === "shop" ? "المحل" : "المستودع"}: ${(done.seriesList || []).join("، ")}.`}
        </Alert>
      )}

      <section className="card">
        <h3>1) اختر الموديل</h3>
        {mn && model.data ? (
          <div className="picked">
            <span><b className="mono">{model.data.modelNumber}</b> · {model.data.brand} {model.data.name}</span>
            <button className="btn small ghost" onClick={() => { setSp({}); setDone(null); }}>تغيير</button>
          </div>
        ) : (
          <>
            <div className="search-bar"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="رقم الموديل أو اسمه" aria-label="بحث عن موديل" autoFocus /></div>
            {found.data?.items?.length === 0 && dq.trim() && <p className="muted">لا يوجد موديل مطابق.{can("models.manage") && <> <Link to="/models/new">أنشئ موديلاً جديداً</Link></>}</p>}
            <ul className="pick-list">
              {found.data?.items?.map((m) => (
                <li key={m.id}><button type="button" onClick={() => { setSp({ model: m.modelNumber }); setQ(""); setDone(null); }}><span className="mono strong">{m.modelNumber}</span> {m.brand} {m.name}</button></li>
              ))}
            </ul>
          </>
        )}
        {model.loading && mn && <Loading />}
        <ErrorBanner error={model.error} onRetry={model.reload} />
      </section>

      {model.data && (
        <form className="card form" onSubmit={review} noValidate>
          <h3>2) أرتال الشحنة</h3>
          <p className="muted small-note">الحالي في المحل / المستودع: {model.data.sizes.map((x) => `${x.size} ${x.shopQty}/${x.warehouseQty}`).join(" · ")}</p>
          <SeriesBuilder sizes={sizes} value={series} onChange={setSeries} onAddSize={(s) => setExtra([...extra, s])} showErrors={showErrors} />

          <div className="grid3">
            <Field label="تُضاف إلى">
              <select value={location} onChange={(e) => setLocation(e.target.value)}><option value="warehouse">المستودع</option><option value="shop">المحل</option></select>
            </Field>
            {canCost && <Field label="سعر الجملة للقطعة في هذه الشحنة (USD)" hint={`التكلفة الحالية ${model.data.costPrice}$. عند الاختلاف تُحسب تكلفة جديدة بالمتوسط المرجّح.`}>
              <input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
            </Field>}
            <Field label="ملاحظة (اختياري)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ملاحظات على الشحنة..." /></Field>
          </div>

          {canSuppliers && (
            <div className="grid3">
              <Field label="التاجر (اختياري)" hint="اختر التاجر لتسجيل فاتورة الشراء والدفع مع الاستلام. بضاعة الأمانة لا تُنشئ فاتورة ولا التزاماً.">
                <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPay({ mode: "unpaid", cash: "", adv: {} }); if (!e.target.value) setConsignment(false); }}>
                  <option value="">بلا تاجر</option>
                  {(suppliers.data?.items || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <label className="check"><input type="checkbox" checked={consignment} disabled={!supplierId} onChange={(e) => setConsignment(e.target.checked)} /> بضاعة أمانة (برسم الأمانة): تبقى ملكاً للتاجر</label>
              {consignment && (
                <Field label="سعر الاتفاق للقطعة (اختياري الآن)" hint="ما ستدفعه للتاجر عن كل قطعة تُباع، بعملة الاتفاق نفسها (لا تحويل). يُحفظ مع الأرتال ولا يُخمَّن لاحقاً؛ دونه لا تُسوّى الأمانة.">
                  <div className="grid2">
                    <input type="number" min="0" step={price.currency === "SYP" ? "1" : "0.01"} value={price.amount} onChange={(e) => setPrice({ ...price, amount: e.target.value })} dir="ltr" aria-label="سعر الاتفاق" />
                    <select value={price.currency} onChange={(e) => setPrice({ ...price, currency: e.target.value })} aria-label="عملة سعر الاتفاق"><option value="USD">$ دولار</option><option value="SYP">ل.س ليرة</option></select>
                  </div>
                </Field>
              )}
            </div>
          )}

          {canSuppliers && supplierId && !consignment && (
            <fieldset className="purchase-box">
              <legend>3) فاتورة الشراء والدفع</legend>
              <label className="check"><input type="checkbox" checked={inv.on} onChange={(e) => setInv({ ...inv, on: e.target.checked })} /> تسجيل فاتورة الشراء مع هذا الاستلام</label>
              {!inv.on && <p className="muted small-note">سيُسجَّل المخزون وربط التاجر فقط، دون فاتورة أو التزام. يمكنك تسجيل الفاتورة لاحقاً من حساب التاجر.</p>}
              {inv.on && (
                <>
                  <div className="grid3">
                    <Field label="رقم فاتورة التاجر" error={showErrors && !inv.no.trim() ? "مطلوب" : ""}><input value={inv.no} onChange={(e) => setInv({ ...inv, no: e.target.value })} dir="ltr" /></Field>
                    <Field label="قيمة الفاتورة" hint={suggested != null ? `مقترح من التكلفة × الكمية: ${suggested}$ (لا يُعتمد تلقائياً)` : "إجمالي الفاتورة كما في ورقة التاجر"}>
                      <div className="grid2">
                        <input type="number" min="0" step={inv.currency === "SYP" ? "1" : "0.01"} value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value })} dir="ltr" aria-label="قيمة الفاتورة" />
                        <select value={inv.currency} onChange={(e) => { setInv({ ...inv, currency: e.target.value }); setPay({ ...pay, adv: {} }); }} aria-label="عملة الفاتورة"><option value="USD">$ دولار</option><option value="SYP">ل.س ليرة</option></select>
                      </div>
                    </Field>
                    <Field label="تاريخ الاستحقاق (اختياري)"><input type="date" value={inv.due} onChange={(e) => setInv({ ...inv, due: e.target.value })} /></Field>
                  </div>
                  {suggested != null && !inv.amount && <div><button type="button" className="btn small ghost" onClick={() => setInv({ ...inv, amount: String(suggested) })}>استخدم المقترح {suggested}$</button></div>}
                  <div role="radiogroup" aria-label="حالة الدفع" className="pay-modes">
                    {PAY_MODES.map(([v, label, hint]) => (
                      <label key={v} className={`pay-mode ${pay.mode === v ? "on" : ""}`}>
                        <input type="radio" name="paymode" checked={pay.mode === v} onChange={() => setPay({ ...pay, mode: v })} />
                        <span><b>{label}</b><small className="muted">{hint}</small></span>
                      </label>
                    ))}
                  </div>
                  {pay.mode === "partial" && (
                    <Field label={`المبلغ المدفوع الآن (${inv.currency === "SYP" ? "ل.س" : "$"})`}>
                      <input type="number" min="0" step={inv.currency === "SYP" ? "1" : "0.01"} value={pay.cash} onChange={(e) => setPay({ ...pay, cash: e.target.value })} dir="ltr" />
                    </Field>
                  )}
                  {pay.mode === "advance" && (
                    allocs.loading ? <Loading /> : advCredits.length === 0 ? (
                      <p className="muted">لا توجد سلف أو دفعات غير مخصَّصة بعملة الفاتورة لهذا التاجر. سجّل سلفة من حسابه أو اختر خياراً آخر.</p>
                    ) : (
                      <div className="adv-list">
                        {advCredits.map((c) => (
                          <Field key={c.id} label={`${c.ref} · متاح ⁦${money(c.available, c.currency)}⁩`}>
                            <input type="number" min="0" max={c.available} step={inv.currency === "SYP" ? "1" : "0.01"} value={pay.adv[c.id] ?? ""} onChange={(e) => setPay({ ...pay, adv: { ...pay.adv, [c.id]: e.target.value } })} dir="ltr" placeholder="المبلغ المخصَّص" />
                          </Field>
                        ))}
                      </div>
                    )
                  )}
                  {total > 0 && (
                    <dl className="pay-summary" aria-live="polite">
                      <div><dt>قيمة الفاتورة</dt><dd>{money(total, inv.currency)}</dd></div>
                      <div><dt>نقد يخرج الآن من صندوق {inv.currency === "SYP" ? "الليرة" : "الدولار"}</dt><dd>{money(cashNow, inv.currency)}</dd></div>
                      <div><dt>سلفة مخصَّصة (بلا نقد جديد)</dt><dd>{money(advNow, inv.currency)}</dd></div>
                      <div className={remaining < 0 ? "bad" : ""}><dt>المتبقي مستحق للتاجر</dt><dd>{money(remaining, inv.currency)}</dd></div>
                    </dl>
                  )}
                </>
              )}
            </fieldset>
          )}

          {formError && <div className="banner error" role="alert">{formError}</div>}
          <ErrorBanner error={apiError} />
          <div className="actions">
            <span className="muted">{series.length} رتل · الإجمالي: <b>{totalQty}</b> قطعة</span>
            <button className="btn primary" disabled={saving}>مراجعة وتأكيد الاستلام</button>
          </div>
        </form>
      )}

      {confirm && (
        <ConfirmDialog title="تأكيد الاستلام"
          message={(
            <>
              {`${consignment ? "[بضاعة أمانة] " : ""}سيُضاف ${series.length} رتل (${totalQty} قطعة) إلى ${location === "shop" ? "المحل" : "المستودع"} للموديل ${model.data.modelNumber}: ${payload.map((x, i) => `[${i + 1}] ${x.sizes.map((y) => `${y.size}×${y.qty}`).join(" ")}`).join("  ")}.`}
              {consignment && <span className="confirm-line">بضاعة أمانة: تبقى ملكاً للتاجر {supplierName}؛ لا فاتورة ولا التزام ولا نقد عند الاستلام، وتُسوّى بعد البيع.</span>}
              {withInvoice && <span className="confirm-line"><b>الفاتورة {inv.no}</b> للتاجر {supplierName}: {money(total, inv.currency)} · نقد يخرج الآن {money(cashNow, inv.currency)} · سلفة مخصَّصة {money(advNow, inv.currency)} · يبقى مستحقاً {money(remaining, inv.currency)}.</span>}
              {!withInvoice && !consignment && supplierId && <span className="confirm-line">بلا فاتورة: لن يُنشأ التزام مالي.</span>}
            </>
          )}
          confirmLabel="تأكيد الاستلام" busy={saving} onConfirm={submit} onCancel={() => setConfirm(false)} />
      )}
    </div>
  );
}
