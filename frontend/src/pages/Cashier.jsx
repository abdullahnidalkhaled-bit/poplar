import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api.js";
import { useAuth } from "../auth.jsx";
import { EmptyState } from "../components/ui/feedback.jsx";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import useDebounced from "../hooks/useDebounced.js";
import { money, usd, flagOf, FLAG_LABEL, invNo, itemLabel, beep } from "../utils.js";

// الكاشير: الباركود/QR/رقم الموديل يمرّ كله عبر /lookup (منطق الخادم الموحّد)
export default function Cashier({ settings, active, exchange, onExchangeEnd }) {
  const { can } = useAuth();
  const rate = settings?.usdToSyp || 0;
  const [cart, setCart] = useState([]);
  const [currency, setCurrency] = useState("USD");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [results, setResults] = useState([]);
  const [picker, setPicker] = useState(null); // موديل بانتظار اختيار المقاس
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);
  const [confirm, setConfirm] = useState(null); // "loss" | "clear"
  const inputRef = useRef(null);
  const submitRef = useRef(null);
  const inflight = useRef(false); // حارس متزامن: setState غير فوري فقد تمرّ نقرات متتالية قبل أن يتحدّث saving

  useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);

  useEffect(() => {
    if (exchange) { setCart([]); setCurrency(exchange.creditCurrency); setDone(null); setMsg(null); setPicker(null); }
  }, [exchange]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      if (e.key === "F2") { e.preventDefault(); inputRef.current?.focus(); }
      else if (e.key === "F9" || (e.ctrlKey && e.key === "Enter")) { e.preventDefault(); submitRef.current?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // بحث يدوي بالاسم/الرقم (بحث الخادم الذكي نفسه)
  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return; }
    let off = false;
    api.get(`/models${qs({ q: dq.trim(), limit: 8 })}`).then((r) => !off && setResults(r.items)).catch(() => {});
    return () => { off = true; };
  }, [dq]);

  const defaultPrice = (sellUsd) => (currency === "USD" ? String(sellUsd) : String(Math.round(sellUsd * rate)));

  const addSize = (model, size) => {
    setDone(null);
    if (size.shopQty < 1) {
      setMsg({ type: "warn", text: `لا توجد كمية في المحل: ${model.modelNumber} (${size.size})` + (size.warehouseQty > 0 ? `. متوفر في المستودع ${size.warehouseQty}: انقله إلى المحل أولاً.` : ". نفد من المخزون.") });
      return;
    }
    setMsg(null);
    setPicker(null);
    setCart((prev) => {
      const i = prev.findIndex((l) => l.sizeId === size.id);
      if (i >= 0) return prev.map((l, idx) => (idx === i ? { ...l, qty: Math.min(l.qty + 1, l.shopQty) } : l));
      return [...prev, {
        modelId: model.id, sizeId: size.id, modelNumber: model.modelNumber, name: model.name, brand: model.brand,
        size: size.size, costPrice: model.costPrice, sellPrice: model.sellPrice, shopQty: size.shopQty, qty: 1,
        unitPrice: defaultPrice(model.sellPrice),
      }];
    });
  };

  const scan = async () => {
    const c = code.trim();
    if (!c) return;
    setCode("");
    try {
      const r = await api.get(`/lookup${qs({ code: c })}`);
      if (r.kind === "size") { addSize(r.model, r.size); beep(r.size.shopQty > 0 ? "ok" : "bad"); }
      else { setPicker(r.model); setMsg(null); beep("ok"); }
    } catch (e) {
      beep("bad");
      setMsg({ type: "error", text: `${e.message} (${c})`, unknown: e.code === "CODE_NOT_FOUND" });
    }
    inputRef.current?.focus();
  };

  const patchLine = (sizeId, patch) => setCart((prev) => prev.map((l) => (l.sizeId === sizeId ? { ...l, ...patch } : l)));
  const removeLine = (sizeId) => setCart((prev) => prev.filter((l) => l.sizeId !== sizeId));

  const changeCurrency = (c) => {
    if (c === currency) return;
    if (c === "SYP" && !(rate > 0)) return setMsg({ type: "warn", text: "حدّد سعر الصرف من الإعدادات أولاً." });
    setCart((prev) => prev.map((l) => {
      const asUsd = currency === "USD" ? Number(l.unitPrice) : Number(l.unitPrice) / rate;
      return { ...l, unitPrice: String(c === "USD" ? Math.round(asUsd * 100) / 100 : Math.round(asUsd * rate)) };
    }));
    setCurrency(c);
  };

  const lines = useMemo(() => cart.map((l) => {
    const price = Number(l.unitPrice) || 0;
    const priceUsd = currency === "USD" ? price : price / rate;
    return { ...l, price, lineTotal: price * l.qty, flag: flagOf(priceUsd, l.costPrice, l.sellPrice, currency, rate) };
  }), [cart, currency, rate]);

  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  const pieces = lines.reduce((s, l) => s + l.qty, 0);
  const lossCount = lines.filter((l) => l.flag === "below_cost").length;
  const lowCount = lines.filter((l) => l.flag === "below_sell_price").length;

  const creditRaw = exchange ? (currency === exchange.creditCurrency ? exchange.creditAmount : currency === "USD" ? exchange.creditAmount / rate : exchange.creditAmount * rate) : 0;
  const credit = currency === "SYP" ? Math.round(creditRaw) : Math.round(creditRaw * 100) / 100;
  const due = total - credit;

  // البيع بأقل من الجملة يمرّ عبر تأكيد صريح قبل الحفظ
  const requestSubmit = () => {
    if (!lines.length || inflight.current) return;
    if (lossCount > 0) setConfirm("loss");
    else submit();
  };
  const submit = async () => {
    if (!lines.length || inflight.current) return;
    inflight.current = true;
    setConfirm(null);
    setSaving(true);
    setMsg(null);
    try {
      const body = { currency, items: lines.map((l) => ({ modelId: l.modelId, sizeId: l.sizeId, qty: l.qty, unitPrice: l.price })) };
      let invoice;
      if (exchange) {
        const res = await api.post("/returns", { invoiceId: exchange.invoice._id, items: exchange.items, reason: exchange.reason, mode: "exchange", newInvoice: body });
        invoice = res.invoice;
        onExchangeEnd();
      } else {
        invoice = await api.post("/invoices", body);
      }
      setDone(invoice);
      setCart([]);
    } catch (e) {
      setMsg({ type: "error", text: e.message });
    } finally {
      inflight.current = false;
      setSaving(false);
      inputRef.current?.focus();
    }
  };
  submitRef.current = requestSubmit;

  return (
    <div className="cashier">
      <section className="cart-col">
        {exchange && (
          <div className="banner warn exchange-banner">
            <span><b>وضع التبديل</b> على الفاتورة #{exchange.invoice.number}: رصيد الزبونة <b>{money(exchange.creditAmount, exchange.creditCurrency)}</b>. امسح القطعة البديلة.</span>
            <button className="btn small ghost" onClick={() => { setCart([]); onExchangeEnd(); }}>إلغاء التبديل</button>
          </div>
        )}
        <div className="scan">
          <label htmlFor="barcode"><span className="dot" /> جاهز للمسح: باركود مقاس أو QR أو رقم موديل</label>
          <input id="barcode" ref={inputRef} className="scan-input" value={code} onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && scan()} placeholder="جاهز للمسح..." autoComplete="off" />
        </div>

        {msg && (
          <div className={`banner ${msg.type}`} role={msg.type === "error" ? "alert" : "status"}>
            <span>{msg.text}</span>
            {msg.unknown && can("models.manage") && <Link className="btn small" to="/models/new">إضافة موديل</Link>}
          </div>
        )}
        {done && (
          <div className="banner ok" role="status">
            <span>تم البيع. الفاتورة {invNo(done.number)} بمبلغ <b>{money(done.cashDue ?? done.totalPaid, done.currency)}</b>{done.creditApplied > 0 && (done.cashDue < 0 ? " (فرق يُردّ للزبونة)" : " بعد خصم رصيد المرتجع")}{done.items.some((i) => i.flag && i.flag !== "normal") && " (فيها بنود بسعر أقل من المحدد)"}</span>
          </div>
        )}

        <div className="manual">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="قطعة بلا ملصق؟ ابحث برقم الموديل أو الاسم" aria-label="بحث يدوي" />
          {dq.trim().length >= 2 && q.trim().length >= 2 && results.length === 0 && <p className="muted small-note" role="status">لا نتائج مطابقة.</p>}
          {results.length > 0 && (
            <ul className="results">
              {results.map((m) => (
                <li key={m.id}>
                  <button onClick={() => { setPicker(m); setQ(""); setResults([]); }}>
                    <span><b className="mono">{m.modelNumber}</b> {m.brand} {m.name}</span>
                    <span className="muted">في المحل: {m.totals.shop}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {picker && (
          <div className="picker card" role="group" aria-label={`اختر مقاس ${picker.modelNumber}`}>
            <div className="picker-head"><span><b className="mono">{picker.modelNumber}</b> {picker.brand} {picker.name}: اختر المقاس</span><button className="icon-btn" onClick={() => setPicker(null)} aria-label="إغلاق">✕</button></div>
            <div className="chips">
              {picker.sizes.map((s) => (
                <button key={s.size} className={`size-chip toggle ${s.shopQty > 0 ? "" : "off"}`} onClick={() => addSize(picker, s)} aria-label={`${s.size}، في المحل ${s.shopQty}`}>
                  {s.size} <small>{s.shopQty}</small>
                </button>
              ))}
            </div>
            <p className="muted small-note">الرقم بجانب المقاس = المتوفر في المحل.</p>
          </div>
        )}

        {lines.length === 0 ? (
          <EmptyState title="الفاتورة فارغة" text="امسح ملصق قطعة أو ابحث عنها بالاسم لإضافتها." />
        ) : (
          <div className="lines">
            {lines.map((l) => (
              <div key={l.sizeId} className={`line flag-${l.flag}`}>
                <div className="line-info">
                  <div className="line-title"><b>{l.brand}</b> {l.name}</div>
                  <div className="muted"><span className="mono">{itemLabel(l)}</span> · بيع {usd(l.sellPrice)}</div>
                  {l.flag !== "normal" && <div className={`flag-badge ${l.flag}`}>{FLAG_LABEL[l.flag]}</div>}
                  {l.qty >= l.shopQty && <div className="muted small-note">الحد الأقصى المتوفر في المحل: {l.shopQty}</div>}
                </div>
                <div className="line-controls">
                  <div className="stepper">
                    <button onClick={() => patchLine(l.sizeId, { qty: Math.max(1, l.qty - 1) })} aria-label="إنقاص">−</button>
                    <span>{l.qty}</span>
                    <button onClick={() => patchLine(l.sizeId, { qty: Math.min(l.shopQty, l.qty + 1) })} aria-label="زيادة">+</button>
                  </div>
                  <label className="price-field"><span className="muted">سعر القطعة</span>
                    <input type="number" min="0" step={currency === "USD" ? "0.01" : "1"} value={l.unitPrice} onChange={(e) => patchLine(l.sizeId, { unitPrice: e.target.value })} />
                  </label>
                  <div className="line-total">{money(l.lineTotal, currency)}</div>
                  <button className="icon-btn" onClick={() => removeLine(l.sizeId)} aria-label="حذف البند">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside className="summary">
        <div className="seg" role="group" aria-label="عملة الدفع">
          <button className={currency === "USD" ? "on" : ""} onClick={() => changeCurrency("USD")}>دولار $</button>
          <button className={currency === "SYP" ? "on" : ""} onClick={() => changeCurrency("SYP")}>ليرة سورية</button>
        </div>
        <div className="total-box">
          <div className="muted">{exchange ? (due >= 0 ? "المطلوب من الزبونة" : "يُردّ للزبونة") : `المبلغ المطلوب (${pieces} قطعة)`}</div>
          <div className="total">{money(Math.abs(exchange ? due : total), currency)}</div>
          {currency === "SYP" && rate > 0 && <div className="muted">≈ {usd(Math.abs(exchange ? due : total) / rate)}</div>}
          {exchange && <div className="muted small-note">البدائل {money(total, currency)} − رصيد المرتجع {money(credit, currency)}</div>}
        </div>
        {lossCount > 0 && <div className="banner error">{lossCount} بند يُباع بأقل من سعر الجملة.</div>}
        {lowCount > 0 && <div className="banner warn">{lowCount} بند بأقل من سعر البيع المحدد.</div>}
        <button className="btn primary big" disabled={!lines.length || saving} onClick={requestSubmit}>
          {saving ? "جارٍ الحفظ..." : exchange ? "إتمام التبديل (F9)" : "إتمام البيع (F9)"}
        </button>
        {lines.length > 0 && <button className="btn ghost" disabled={saving} onClick={() => setConfirm("clear")}>إفراغ الفاتورة</button>}
        <p className="muted small-note">F2 للتركيز على المسح · F9 لإتمام البيع</p>
      </aside>
      {confirm === "loss" && (
        <ConfirmDialog title="بيع بأقل من سعر الجملة" danger busy={saving} confirmLabel="متابعة البيع"
          message={`في الفاتورة ${lossCount} بند يُباع بأقل من سعر الجملة (خسارة). هل تريد المتابعة؟`} onConfirm={submit} onCancel={() => setConfirm(null)} />
      )}
      {confirm === "clear" && (
        <ConfirmDialog title="إفراغ الفاتورة؟" danger confirmLabel="إفراغ" message={`ستُحذف ${lines.length} بند من الفاتورة الحالية دون بيع.`}
          onConfirm={() => { setCart([]); setConfirm(null); inputRef.current?.focus(); }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
