import PageHeader from "../components/ui/PageHeader.jsx";
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { money, usd, todayStr, dayRange, fmtTime, invNo, FLAG_LABEL, variantLabel } from "../utils.js";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import { Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import ReturnModal from "../components/ReturnModal.jsx";

const returnState = (inv) => {
  const total = inv.items.reduce((s, i) => s + i.qty, 0);
  const back = inv.items.reduce((s, i) => s + (i.returnedQty || 0), 0);
  return back === 0 ? "none" : back >= total ? "full" : "partial";
};

export default function Invoices({ rate, onStartExchange }) {
  const { can } = useAuth();
  const costs = can("costs.view"); // الربح والجملة وفرق الصرف: للمالك فقط (الخادم لا يرسلها لغيره)
  const [date, setDate] = useState(todayStr());
  const [invoices, setInvoices] = useState([]);
  const [returns, setReturns] = useState([]);
  const [open, setOpen] = useState(null);
  const [returning, setReturning] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(null); // فاتورة بانتظار تأكيد الإلغاء
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = dayRange(date);
    const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    Promise.all([api.get(`/invoices${q}`), can("returns.read") ? api.get(`/returns${q}`) : Promise.resolve([])])
      .then(([inv, ret]) => {
        if (cancelled) return;
        setInvoices(inv);
        setReturns(ret);
        setError("");
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [date, tick]);

  const cancel = async () => {
    if (inflight.current || !cancelling) return;
    inflight.current = true;
    setBusy(true);
    setNotice("");
    try {
      const r = await api.post(`/invoices/${cancelling._id}/cancel`);
      if (r.notRestocked > 0) setError(`تم الإلغاء، لكن ${r.notRestocked} بند لم يُعَد للمخزون لأن منتجه حُذف.`);
      else setNotice(`تم إلغاء الفاتورة ${invNo(cancelling.number)} وأُعيدت قطعها إلى المحل.`);
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      inflight.current = false;
      setBusy(false);
      setCancelling(null);
    }
  };

  const returnDone = (res) => {
    setReturning(null);
    setNotice(`تم تسجيل المرتجع RET-${res.return.number} وردّ ${money(res.return.refundAmount, res.return.currency)} للزبونة.`);
    reload();
  };

  return (
    <div>
      <PageHeader title="الفواتير"><input type="date" aria-label="يوم الفواتير" value={date} onChange={(e) => setDate(e.target.value)} /></PageHeader>
      <ErrorBanner error={error ? { message: error } : null} onRetry={reload} />
      {notice && <div className="banner ok" role="status"><span>{notice}</span><button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button></div>}
      {loading ? (
        <Loading />
      ) : invoices.length === 0 ? (
        <EmptyState title="لا توجد فواتير في هذا اليوم" text="اختر يوماً آخر من الأعلى." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>الرقم</th><th>الوقت</th><th>القطع</th><th>المبلغ</th>{costs && <th>الربح</th>}<th>الحالة</th><th /></tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const rs = returnState(inv);
                const worst = !costs ? "normal" : inv.items.some((i) => i.flag === "below_cost") ? "below_cost"
                  : inv.items.some((i) => i.flag === "below_sell_price") ? "below_sell_price" : "normal";
                const canReturn = inv.status === "completed" && rs !== "full";
                const canCancel = inv.status === "completed" && rs === "none" && !inv.returnRef;
                return [
                  <tr key={inv._id} className={`clickable ${inv.status === "cancelled" ? "cancelled" : ""}`} onClick={() => setOpen(open === inv._id ? null : inv._id)}>
                    <td>{invNo(inv.number)}</td>
                    <td>{fmtTime(inv.createdAt)}</td>
                    <td>{inv.itemsCount}</td>
                    <td>
                      {money(inv.cashDue ?? inv.totalPaid, inv.currency)}
                      {inv.creditApplied > 0 && <span className="muted small-note"> (بعد رصيد مرتجع)</span>}
                    </td>
                    {costs && <td className={inv.profitUsd < 0 ? "loss-text" : ""}>{usd(inv.profitUsd)}</td>}
                    <td>
                      <div className="status-cell">
                        {inv.status === "cancelled" ? <span className="pill cancelled">ملغاة</span> : <>
                          {inv.returnRef && <span className="pill">تبديل على #{inv.exchangeOfInvoice}</span>}
                          {rs === "full" && <span className="pill cancelled">مرتجعة بالكامل</span>}
                          {rs === "partial" && <span className="flag-badge below_sell_price">مرتجع جزئي</span>}
                          {worst !== "normal" && <span className={`flag-badge ${worst}`}>{FLAG_LABEL[worst]}</span>}
                          {!inv.returnRef && rs === "none" && worst === "normal" && "مكتملة"}
                        </>}
                      </div>
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      {canReturn && can("returns.create") && <button className="btn small" onClick={() => { setNotice(""); setReturning(inv); }}>إرجاع / تبديل</button>}
                      {canCancel && can("invoices.cancel") && <button className="btn small danger" onClick={() => setCancelling(inv)}>إلغاء الفاتورة</button>}
                    </td>
                  </tr>,
                  open === inv._id && (
                    <tr key={inv._id + "i"} className="subrow">
                      <td colSpan="7">
                        <table className="inner">
                          <thead><tr><th>القطعة</th><th>الكمية</th><th>أُرجع</th><th>سعر البيع الفعلي</th>{costs && <th>الجملة</th>}<th>البيع المحدد</th>{costs && <th>تنبيه</th>}</tr></thead>
                          <tbody>
                            {inv.items.map((it, i) => (
                              <tr key={i}>
                                <td><b>{it.brand}</b> {it.name} · {variantLabel(it)}</td>
                                <td>{it.qty}</td>
                                <td>{it.returnedQty || 0}</td>
                                <td>{money(it.unitPrice, inv.currency)}</td>
                                {costs && <td>{usd(it.costPrice)}</td>}
                                <td>{usd(it.sellPrice)}</td>
                                {costs && <td>{it.flag !== "normal" && <span className={`flag-badge ${it.flag}`}>{FLAG_LABEL[it.flag]}</span>}</td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {inv.creditApplied > 0 && (
                          <p className="muted small-note">
                            مجموع البنود {money(inv.totalPaid, inv.currency)} − رصيد المرتجع {money(inv.creditApplied, inv.currency)} = {money(inv.cashDue, inv.currency)}
                            {inv.cashDue < 0 && " (فرق رُدّ للزبونة)"}
                          </p>
                        )}
                        {inv.currency === "SYP" && <p className="muted small-note">سعر الصرف وقت البيع: {inv.rate.toLocaleString("en-US")}</p>}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {returns.length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>مرتجعات هذا اليوم</h3>
          <table>
            <thead><tr><th>الرقم</th><th>الفاتورة</th><th>القطع</th><th>القيمة المردودة</th><th>النوع</th>{costs && <th>فرق الصرف</th>}<th>السبب</th></tr></thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r._id}>
                  <td>RET-{r.number}</td>
                  <td>{invNo(r.invoiceNumber)}</td>
                  <td>{r.items.map((i) => `${i.name} ${variantLabel(i)} ×${i.qty}${i.condition === "damaged" ? " (تالف)" : ""}`).join("، ")}</td>
                  <td>{money(r.refundAmount, r.currency)}</td>
                  <td>{r.mode === "exchange" ? `تبديل → ${invNo(r.exchangeInvoiceNumber)}` : "استرداد نقدي"}</td>
                  {costs && <td className={r.fxDiffUsd > 0.004 ? "loss-text" : r.fxDiffUsd < -0.004 ? "gain-text" : ""}>
                    {Math.abs(r.fxDiffUsd) < 0.005 ? "—" : `${usd(Math.abs(r.fxDiffUsd))} ${r.fxDiffUsd > 0 ? "خسارة" : "ربح"}`}
                  </td>}
                  <td className="muted">{r.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cancelling && (
        <ConfirmDialog title={`إلغاء الفاتورة ${invNo(cancelling.number)}؟`} danger busy={busy} confirmLabel="إلغاء الفاتورة"
          message="ستعود القطع إلى مخزون المحل ويُعكَس أثر البيع في الصندوق. لا يمكن التراجع عن الإلغاء."
          onConfirm={cancel} onCancel={() => setCancelling(null)} />
      )}

      {returning && (
        <ReturnModal
          invoice={returning}
          rate={rate}
          onClose={() => setReturning(null)}
          onDone={returnDone}
          onStartExchange={(ex) => { setReturning(null); onStartExchange(ex); }}
        />
      )}
    </div>
  );
}
