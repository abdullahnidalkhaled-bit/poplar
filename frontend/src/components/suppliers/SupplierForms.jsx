import { useMemo, useRef, useState } from "react";
import { api, qs } from "../../api.js";
import useAsync from "../../hooks/useAsync.js";
import useDebounced from "../../hooks/useDebounced.js";
import Modal from "../ui/Modal.jsx";
import ConfirmDialog from "../ui/ConfirmDialog.jsx";
import Field from "../ui/Field.jsx";
import { Loading, ErrorBanner, EmptyState } from "../ui/feedback.jsx";
import { newKey, money, PLACE, todayStr, compareSizes, ENTRY_TYPE, CUR, CUR_NAME } from "../../utils.js";

const iso = (d) => (d ? new Date(`${d}T12:00:00`).toISOString() : undefined);

// حقول المبلغ: المبلغ بعملته الأصلية فقط. سعر الصرف اختياري ويُحفظ للتوثيق (لا يُحسب به أي رصيد ولا نقد ولا يُجلب من الإعدادات)
function MoneyFields({ f, set, amountLabel = "المبلغ", noRate }) {
  const syp = f.currency === "SYP";
  return (
    <div className="grid3">
      <Field label={`${amountLabel} (${CUR[f.currency]})`} hint={syp ? "عدد صحيح بالليرة" : "خانتان عشريتان كحد أقصى"}>
        <input type="number" min="0" step={syp ? "1" : "0.01"} value={f.amount} onChange={set("amount")} required dir="ltr" inputMode="decimal" />
      </Field>
      <Field label="العملة"><select value={f.currency} onChange={set("currency")}><option value="USD">دولار (USD)</option><option value="SYP">ليرة سورية (SYP)</option></select></Field>
      {!noRate && syp && (
        <Field label="سعر صرف للتوثيق (اختياري)" hint="يُحفظ كما أُدخل فقط؛ لا يُحسب به أي رصيد أو نقد.">
          <input type="number" min="0" step="any" value={f.rate} onChange={set("rate")} dir="ltr" />
        </Field>
      )}
    </div>
  );
}

const moneyBody = (f) => ({ amount: Number(f.amount), currency: f.currency, ...(f.currency === "SYP" && f.rate ? { rate: Number(f.rate) } : {}) });

function useSubmit(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    if (busy) return; // منع الإرسال المزدوج
    setBusy(true); setError(null);
    try { const out = await fn(); onDone(out); } catch (e) { setError(e); setBusy(false); }
  };
  return { busy, error, run };
}

// ---------------------------------------------------------------- تاجر: إنشاء/تعديل
export function SupplierFormModal({ supplier, onClose, onDone }) {
  const [f, setF] = useState({ name: supplier?.name || "", phone: supplier?.phone || "", address: supplier?.address || "", notes: supplier?.notes || "" });
  const [dup, setDup] = useState(null);
  const { busy, error, run } = useSubmit(onDone);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e, allowDuplicate = false) => {
    e?.preventDefault();
    const body = { ...f, name: f.name.trim(), ...(allowDuplicate ? { allowDuplicate: true } : {}) };
    run(async () => {
      try { return supplier ? await api.patch(`/suppliers/${supplier.id}`, body) : await api.post("/suppliers", body); }
      catch (err) { if (err.code === "DUPLICATE_SUPPLIER") setDup(err.message); throw err; }
    });
  };
  return (
    <Modal title={supplier ? `تعديل ${supplier.name}` : "تاجر جديد"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="اسم التاجر"><input value={f.name} onChange={set("name")} required maxLength={120} autoFocus /></Field>
        <Field label="الهاتف"><input value={f.phone} onChange={set("phone")} maxLength={40} dir="ltr" inputMode="tel" /></Field>
        <Field label="العنوان"><input value={f.address} onChange={set("address")} maxLength={300} /></Field>
        <Field label="ملاحظات"><textarea rows={3} value={f.notes} onChange={set("notes")} maxLength={1000} /></Field>
        {dup ? (
          <div className="banner warn" role="alert"><span>{dup}</span><button type="button" className="btn small" onClick={(e) => submit(e, true)} disabled={busy}>هو تاجر مختلف: متابعة</button></div>
        ) : <ErrorBanner error={error} />}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn primary" disabled={busy || !f.name.trim()}>{busy ? "جارٍ الحفظ..." : "حفظ"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- فاتورة تاجر (التزام بعملتها، بلا أثر على النقد)
export function InvoiceModal({ supplierId, onClose, onDone }) {
  const key = useRef(newKey());
  const [f, setF] = useState({ invoiceNo: "", invoiceDate: todayStr(), dueDate: "", amount: "", currency: "USD", rate: "", terms: "", note: "", seriesNos: "" });
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const body = () => ({
    invoiceNo: f.invoiceNo.trim(), invoiceDate: iso(f.invoiceDate), ...(f.dueDate ? { dueDate: iso(f.dueDate) } : {}), ...moneyBody(f),
    terms: f.terms.trim() || undefined, note: f.note.trim() || undefined,
    seriesNos: f.seriesNos.split(/[\s,،]+/).map((s) => s.trim().toUpperCase()).filter(Boolean), idempotencyKey: key.current,
  });
  return (
    <Modal title="تسجيل فاتورة شراء من تاجر" onClose={onClose} wide>
      <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
        <p className="muted small-note">فاتورة التاجر التزام مالي بعملتها، ولا تُخرج أي نقد من أي صندوق: النقد يخرج فقط عند تسجيل دفعة فعلية. بضاعة الأمانة لا تُسجَّل هنا بل من تبويب «تسويات الأمانة».</p>
        <div className="grid3">
          <Field label="رقم فاتورة التاجر"><input value={f.invoiceNo} onChange={set("invoiceNo")} required maxLength={60} dir="ltr" autoFocus /></Field>
          <Field label="تاريخ الفاتورة"><input type="date" value={f.invoiceDate} onChange={set("invoiceDate")} required /></Field>
          <Field label="تاريخ الاستحقاق (اختياري)"><input type="date" value={f.dueDate} onChange={set("dueDate")} min={f.invoiceDate} /></Field>
        </div>
        <MoneyFields f={f} set={set} amountLabel="قيمة الفاتورة" />
        <div className="grid3">
          <Field label="شروط الدفع"><input value={f.terms} onChange={set("terms")} maxLength={200} placeholder="مثال: خلال 30 يوماً" /></Field>
          <Field label="أرتال مرتبطة (اختياري)" hint="أرقام أرتال مملوكة مفصولة بفاصلة"><input value={f.seriesNos} onChange={set("seriesNos")} dir="ltr" placeholder="SER-000123, SER-000124" /></Field>
          <Field label="ملاحظات"><input value={f.note} onChange={set("note")} maxLength={500} /></Field>
        </div>
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn primary" disabled={busy || !f.invoiceNo.trim() || !(Number(f.amount) > 0)}>مراجعة وتسجيل</button>
        </div>
      </form>
      {confirm && (
        <ConfirmDialog title="تأكيد تسجيل الفاتورة" confirmLabel="تسجيل الفاتورة" busy={busy}
          message={`سيُسجَّل التزام بقيمة ${money(Number(f.amount), f.currency)} للفاتورة ${f.invoiceNo.trim()}، دون أي أثر على الصندوق. لا يمكن تعديل القيد بعد ترحيله؛ يُصحَّح بقيد عكسي.`}
          onCancel={() => setConfirm(false)} onConfirm={() => { run(() => api.post(`/suppliers/${supplierId}/invoices`, body())); setConfirm(false); }} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- دفعة / سلفة / إشعار دائن / تسوية مدينة
const MODES = {
  payment: { title: "تسجيل دفعة للتاجر", path: "payments", confirm: "تسجيل الدفعة", verb: "دفعة", cash: true },
  advance: { title: "تسجيل سلفة للتاجر", path: "advances", confirm: "تسجيل السلفة", verb: "سلفة", cash: true },
  credit: { title: "إشعار دائن (يخفض المستحق)", path: "adjustments", confirm: "تسجيل الإشعار", verb: "إشعار دائن" },
  adjustment: { title: "تسوية مدينة (تزيد المستحق)", path: "adjustments", confirm: "تسجيل التسوية", verb: "تسوية مدينة" },
};

// initialInvoice: فتح النموذج من فاتورة بعينها (يُملأ الربط والعملة والمتبقي مسبقاً؛ المبلغ الفعلي يُدخله المستخدم)
export function EntryModal({ mode, supplierId, invoices, initialInvoice, onClose, onDone }) {
  const m = MODES[mode];
  const key = useRef(newKey());
  const [f, setF] = useState({ amount: initialInvoice ? String(initialInvoice.outstanding) : "", currency: initialInvoice?.currency || "USD", rate: "", invoiceId: initialInvoice?.id || "", date: todayStr(), note: initialInvoice && mode === "credit" ? `إشعار دائن على الفاتورة ${initialInvoice.invoiceNo}` : "", settles: "", xrate: "" });
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const manual = mode === "credit" || mode === "adjustment";
  const open = (invoices || []).filter((i) => i.status === "posted" && i.outstanding > 0);
  const inv = open.find((i) => i.id === f.invoiceId);
  const cross = !!inv && mode === "payment" && inv.currency !== f.currency;
  const mismatchCredit = !!inv && mode === "credit" && inv.currency !== f.currency;
  const body = () => ({
    ...(manual ? { kind: mode } : {}), ...moneyBody(f), ...(f.invoiceId && (mode === "payment" || mode === "credit") ? { invoiceId: f.invoiceId } : {}),
    ...(cross ? { crossCurrency: { settlesAmount: Number(f.settles), rate: Number(f.xrate) } } : {}),
    date: iso(f.date), ...(f.note.trim() ? { note: f.note.trim() } : {}), idempotencyKey: key.current,
  });
  const ready = Number(f.amount) > 0 && (!manual || f.note.trim()) && !mismatchCredit && (!cross || (Number(f.settles) > 0 && Number(f.xrate) > 0));
  return (
    <Modal title={m.title} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
        {m.cash && <p className="hint-box">{m.verb === "سلفة" ? "السلفة" : "الدفعة"} نقد يخرج فعلاً من <b>صندوق {CUR_NAME[f.currency]}</b> فقط (عملة الدفع التي تختارها)، ولا تمسّ الصندوق الآخر.</p>}
        {mode === "advance" && <p className="muted small-note">تبقى السلفة «غير مطبّقة» ظاهرة منفصلة عن المستحقات حتى تخصّصها على فاتورة (يدوياً أو بالتطبيق التلقائي)، والتخصيص لا يُخرج نقداً جديداً.</p>}
        <MoneyFields f={f} set={set} />
        {(mode === "payment" || mode === "credit") && (
          <Field label="ربط بفاتورة (اختياري)" hint="الأفضل الدفع بعملة الفاتورة نفسها.">
            <select value={f.invoiceId} onChange={set("invoiceId")}>
              <option value="">بلا ربط (رصيد دائن متاح)</option>
              {open.map((i) => <option key={i.id} value={i.id}>{i.invoiceNo} — متبقٍ {money(i.outstanding, i.currency)}</option>)}
            </select>
          </Field>
        )}
        {mismatchCredit && <div className="banner error" role="alert"><span>الإشعار الدائن يُربط بفاتورة بنفس عملته فقط. اختر عملة الفاتورة ({inv.currency}) أو أزل الربط.</span></div>}
        {cross && (
          <div className="card">
            <div className="banner warn" role="status"><span>الفاتورة بعملة {CUR_NAME[inv.currency]} والدفع بعملة {CUR_NAME[f.currency]}. هذا تسوية عبر عملتين: يلزم تأكيد صريح للمبلغ المُسدَّد من الفاتورة وسعر الصرف. لن يُشتق أي مبلغ تلقائياً، ويخرج النقد من صندوق {CUR_NAME[f.currency]} فقط.</span></div>
            <div className="grid2">
              <Field label={`المبلغ المُسدَّد من الفاتورة (${CUR[inv.currency]})`} hint={`المتبقي ${money(inv.outstanding, inv.currency)}`}><input type="number" min="0" step={inv.currency === "SYP" ? "1" : "0.01"} value={f.settles} onChange={set("settles")} required dir="ltr" /></Field>
              <Field label="سعر الصرف المُدخَل (ل.س لكل 1$)"><input type="number" min="0" step="any" value={f.xrate} onChange={set("xrate")} required dir="ltr" /></Field>
            </div>
          </div>
        )}
        <Field label="التاريخ"><input type="date" value={f.date} onChange={set("date")} max={todayStr()} /></Field>
        <Field label={manual ? "السبب (إلزامي)" : "ملاحظة"}><input value={f.note} onChange={set("note")} required={manual} maxLength={500} /></Field>
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn primary" disabled={busy || !ready}>مراجعة وتسجيل</button>
        </div>
      </form>
      {confirm && (
        <ConfirmDialog title={`تأكيد ${m.verb}`} confirmLabel={m.confirm} busy={busy}
          message={`سيُسجَّل ${m.verb} بمبلغ ${money(Number(f.amount), f.currency)}${m.cash ? ` ويُخصم من صندوق ${CUR_NAME[f.currency]} فقط` : " دون أي أثر على النقد"}${f.invoiceId ? ` وتُخصَّص على الفاتورة ${inv?.invoiceNo}` : ""}. لا يمكن تعديل القيد بعد ترحيله (يُصحَّح بقيد عكسي).`}
          onCancel={() => setConfirm(false)} onConfirm={() => { run(() => api.post(`/suppliers/${supplierId}/${m.path}`, body())); setConfirm(false); }} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- تخصيص رصيد دائن على فاتورة (لا ينشئ حركة نقد)
export function AllocateModal({ supplierId, credits, invoices, initialCredit, initialInvoice, onClose, onDone }) {
  const key = useRef(newKey());
  const open = (invoices || []).filter((i) => i.status === "posted" && i.outstanding > 0);
  const avail = (credits || []).filter((c) => c.available > 0);
  const [creditId, setCreditId] = useState(initialCredit || (initialInvoice && avail.find((c) => c.currency === initialInvoice.currency)?.id) || avail[0]?.id || "");
  const credit = avail.find((c) => c.id === creditId);
  const sameCur = open.filter((i) => !credit || i.currency === credit.currency);
  const [invoiceId, setInvoiceId] = useState(initialInvoice?.id || "");
  const invoice = open.find((i) => i.id === (invoiceId || (sameCur[0] || open[0])?.id));
  const cross = !!credit && !!invoice && credit.currency !== invoice.currency;
  const sameMax = credit && invoice && !cross ? Math.min(credit.available, invoice.outstanding) : 0;
  const [amount, setAmount] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const value = cross ? Number(amount) : amount === "" ? sameMax : Number(amount);
  const ready = !!credit && !!invoice && value > 0 && (!cross || (Number(creditAmount) > 0 && Number(rate) > 0));
  return (
    <Modal title="تخصيص رصيد دائن على فاتورة" onClose={onClose}>
      {avail.length === 0 || open.length === 0 ? <EmptyState title="لا شيء للتخصيص" text={avail.length === 0 ? "لا توجد دفعات أو سلف متاحة." : "لا توجد فواتير مفتوحة."} /> : (
        <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
          <p className="muted small-note">التخصيص يربط رصيداً دفع سابقاً بفاتورة، ولا يُخرج أي نقد (خرج عند دفع السلفة أصلاً).</p>
          <Field label="الرصيد الدائن (سلفة/دفعة)">
            <select value={creditId} onChange={(e) => { setCreditId(e.target.value); setInvoiceId(""); setAmount(""); }}>
              {avail.map((c) => <option key={c.id} value={c.id}>{c.ref} · {ENTRY_TYPE[c.type]} · متاح {money(c.available, c.currency)}</option>)}
            </select>
          </Field>
          <Field label="الفاتورة">
            <select value={invoice?.id || ""} onChange={(e) => { setInvoiceId(e.target.value); setAmount(""); }}>
              {open.map((i) => <option key={i.id} value={i.id}>{i.invoiceNo} · متبقٍ {money(i.outstanding, i.currency)}{credit && i.currency !== credit.currency ? " (عملة مختلفة)" : ""}</option>)}
            </select>
          </Field>
          {cross ? (
            <div className="card">
              <div className="banner warn" role="status"><span>الرصيد بعملة {CUR_NAME[credit.currency]} والفاتورة بعملة {CUR_NAME[invoice.currency]}: تخصيص عبر عملتين. أدخل المبلغين وسعر الصرف صراحةً؛ لا يُشتق شيء تلقائياً.</span></div>
              <div className="grid3">
                <Field label={`المُسدَّد من الفاتورة (${CUR[invoice.currency]})`} hint={`المتبقي ${money(invoice.outstanding, invoice.currency)}`}><input type="number" min="0" step={invoice.currency === "SYP" ? "1" : "0.01"} value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" required /></Field>
                <Field label={`المستهلك من الرصيد (${CUR[credit.currency]})`} hint={`المتاح ${money(credit.available, credit.currency)}`}><input type="number" min="0" step={credit.currency === "SYP" ? "1" : "0.01"} value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} dir="ltr" required /></Field>
                <Field label="سعر الصرف (ل.س لكل 1$)"><input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} dir="ltr" required /></Field>
              </div>
            </div>
          ) : (
            <Field label={`المبلغ المخصَّص (${credit ? CUR[credit.currency] : ""})`} hint={`الحد الأقصى ${money(sameMax, credit?.currency)} (الأقل من المتاح والمتبقي)`}>
              <input type="number" min="0" max={sameMax} step={credit?.currency === "SYP" ? "1" : "0.01"} value={amount === "" ? sameMax : amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" required />
            </Field>
          )}
          <Field label="ملاحظة"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
          <ErrorBanner error={error} />
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
            <button className="btn primary" disabled={busy || !ready || (!cross && value > sameMax + 1e-9)}>مراجعة وتخصيص</button>
          </div>
        </form>
      )}
      {confirm && (
        <ConfirmDialog title="تأكيد التخصيص" confirmLabel="تخصيص" busy={busy}
          message={cross
            ? `سيُسدَّد ${money(value, invoice.currency)} من الفاتورة ${invoice.invoiceNo} مقابل ${money(Number(creditAmount), credit.currency)} من ${credit.ref} بسعر صرف مُدخَل ${rate}. بلا أي حركة نقد.`
            : `سيُخصَّص ${money(value, credit.currency)} من ${credit.ref} على الفاتورة ${invoice.invoiceNo}. بلا أي حركة نقد، ويمكن تحريره لاحقاً.`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { run(() => api.post(`/suppliers/${supplierId}/allocations`, { entryId: creditId, invoiceId: invoice.id, amount: value, ...(cross ? { creditAmount: Number(creditAmount), rate: Number(rate), crossCurrency: true } : {}), note: note.trim() || undefined, idempotencyKey: key.current })); setConfirm(false); }} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- عكس (قيد أو تخصيص أو تسوية) بسبب إلزامي
export function ReasonModal({ title, text, url, confirmLabel = "تنفيذ", onClose, onDone }) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit(onDone);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); run(() => api.post(url, { reason: reason.trim() })); }}>
        <p>{text}</p>
        <Field label="السبب (إلزامي)"><input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus /></Field>
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn danger" disabled={busy || !reason.trim()}>{busy ? "جارٍ التنفيذ..." : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- سعر الاتفاق (تسجيل أول / تعديل مصرَّح به) بعملته الأصلية
export function PriceModal({ supplierId, rows, onClose, onDone }) {
  const adjust = rows.some((r) => r.price);
  const mixedKinds = adjust && rows.some((r) => !r.price);
  const [f, setF] = useState({ amount: "", currency: "USD" });
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={adjust ? "تعديل سعر اتفاق (مصرَّح به)" : "تسجيل سعر الاتفاق"} onClose={onClose}>
      {mixedKinds ? <p className="banner warn">اختر أرتالاً بلا سعر فقط (تسجيل أول) أو أرتالاً مسعّرة فقط (تعديل). لا يُخلط بينهما.</p> : (
        <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
          <p className="muted small-note">الأرتال: <span className="mono">{rows.map((r) => r.seriesNo).join("، ")}</span>. السعر ما اتفقتم عليه مع التاجر للقطعة بعملته نفسها (لا يُحوَّل لعملة أخرى). يُحفظ لقطةً ويُستعمل في التسوية والتقييم. {adjust ? "التعديل لا يغيّر تسويات سابقة ويبقى السعر القديم في السجل." : "لا يُخمَّن السعر من سعر الجملة."}</p>
          <MoneyFields f={f} set={set} amountLabel="سعر القطعة" noRate />
          <Field label={adjust ? "سبب التعديل (إلزامي)" : "مرجع الاتفاق (إلزامي)"}><input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder={adjust ? "مثال: اتفاق جديد بعد تخفيض" : "مثال: اتفاق هاتفي بتاريخ ..."} /></Field>
          <ErrorBanner error={error} />
          <div className="actions">
            <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
            <button className="btn primary" disabled={busy || !(Number(f.amount) > 0) || !reason.trim()}>مراجعة وحفظ</button>
          </div>
        </form>
      )}
      {confirm && (
        <ConfirmDialog title={adjust ? "تأكيد تعديل السعر" : "تأكيد تسجيل السعر"} confirmLabel="حفظ السعر" busy={busy}
          message={`سعر القطعة ${money(Number(f.amount), f.currency)} لـ ${rows.length} رتل. سيُسجَّل في سجل الأسعار ولا يُحذف.`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { run(() => api.post(`/suppliers/${supplierId}/consignment/prices`, { seriesIds: rows.map((r) => r.seriesId || r.id), price: { amount: Number(f.amount), currency: f.currency }, adjust, reason: reason.trim() })); setConfirm(false); }} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- تسوية بضاعة أمانة مباعة (بعملة واحدة)
export function SettleModal({ supplierId, lines, onClose, onDone }) {
  const key = useRef(newKey());
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone);
  const curs = [...new Set(lines.map((l) => l.price.currency))];
  const single = curs.length === 1 ? curs[0] : null;
  const lineVal = (l) => l.qty * (l.price.currency === "SYP" ? l.price.amount : Math.round(l.price.amount * 100) / 100);
  const total = single ? lines.reduce((n, l) => n + lineVal(l), 0) : 0;
  const qty = lines.reduce((n, l) => n + l.qty, 0);
  return (
    <Modal title="تسوية بضاعة أمانة مباعة" onClose={onClose} wide>
      <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
        <p className="muted small-note">ستنشأ فاتورة تسوية والتزام للتاجر بسعر الاتفاق المسجَّل لكل رتل وبعملته (لا بسعر البيع للزبون ولا سعر الجملة)، وتُحجز الكميات المسوّاة فلا تُسوّى مرة ثانية. التسوية التزام فقط ولا تُخرج نقداً.</p>
        {!single && <div className="banner error" role="alert"><span>البنود المحددة بأسعار اتفاق بعملتين مختلفتين. سجّل تسوية منفصلة لكل عملة (لا يُخلط الدولار والليرة في التزام واحد).</span></div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>الرتل</th><th>الموديل</th><th>المقاس</th><th className="num">الكمية</th><th className="num">سعر الاتفاق</th><th className="num">القيمة</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={`${l.seriesId}|${l.size}`}>
                  <td className="mono">{l.seriesNo}</td><td><span className="mono strong">{l.modelNumber}</span></td><td><span className="size-chip">{l.size}</span></td>
                  <td className="num">{l.qty}</td><td className="num">{money(l.price.amount, l.price.currency)}</td><td className="num">{money(lineVal(l), l.price.currency)}</td>
                </tr>
              ))}
            </tbody>
            {single && <tfoot><tr><th scope="row" colSpan={3}>المجموع ({CUR_NAME[single]})</th><td className="num"><b>{qty}</b></td><td /><td className="num"><b>{money(total, single)}</b></td></tr></tfoot>}
          </table>
        </div>
        <Field label="ملاحظات"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <ErrorBanner error={error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>إلغاء</button>
          <button className="btn primary" disabled={busy || !lines.length || !single}>مراجعة التسوية</button>
        </div>
      </form>
      {confirm && (
        <ConfirmDialog title="تأكيد التسوية" confirmLabel="تسجيل التسوية" busy={busy}
          message={`سيُسجَّل للتاجر التزام ${money(total, single)} عن ${qty} قطعة مباعة. بلا أي أثر على النقد. التصحيح لاحقاً بعكس التسوية.`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { run(() => api.post(`/suppliers/${supplierId}/settlements`, { items: lines.map((l) => ({ seriesId: l.seriesId, size: l.size, qty: l.qty })), note: note.trim() || undefined, idempotencyKey: key.current })); setConfirm(false); }} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- إرجاع بضاعة أمانة
export function ReturnConsignmentModal({ supplierId, invoices, onClose, onDone }) {
  const key = useRef(newKey());
  const [text, setText] = useState("");
  const dq = useDebounced(text, 250);
  const [location, setLocation] = useState("");
  const list = useAsync(() => api.get(`/suppliers/${supplierId}/consignment${qs({ q: dq, location })}`), [supplierId, dq, location]);
  const [pick, setPick] = useState({});
  const [step, setStep] = useState("select");
  const [reason, setReason] = useState("");
  const [withCredit, setWithCredit] = useState(false);
  const [cr, setCr] = useState({ amount: "", currency: "USD", rate: "", invoiceId: "", note: "" });
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useSubmit(onDone);

  const series = list.data?.series || [];
  const known = useRef({});
  series.forEach((s) => { known.current[s.id] = s; });
  const setQty = (s, size, max, v) => {
    const q = Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
    setPick((p) => { const next = { ...p }; if (q) next[`${s.id}|${size}`] = q; else delete next[`${s.id}|${size}`]; return next; });
  };
  const detailed = useMemo(() => Object.entries(pick).map(([k, qty]) => { const [seriesId, size] = k.split("|"); return { seriesId, size, qty, s: known.current[seriesId] }; }).filter((l) => l.s), [pick, list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalQty = detailed.reduce((n, l) => n + l.qty, 0);
  const valueBy = { USD: 0, SYP: 0 };
  let unpriced = 0;
  for (const l of detailed) { if (l.s.price) valueBy[l.s.price.currency] += l.qty * l.s.price.amount; else unpriced += l.qty; }
  const valueText = ["USD", "SYP"].filter((c) => valueBy[c] > 0).map((c) => money(valueBy[c], c)).join(" + ");

  const body = () => ({
    items: detailed.map((l) => ({ seriesId: l.seriesId, size: l.size, qty: l.qty })), reason: reason.trim(), idempotencyKey: key.current,
    ...(withCredit ? { credit: { ...moneyBody(cr), ...(cr.invoiceId ? { invoiceId: cr.invoiceId } : {}), ...(cr.note.trim() ? { note: cr.note.trim() } : {}) } } : {}),
  });
  const open = (invoices || []).filter((i) => i.status === "posted" && i.outstanding > 0 && i.currency === cr.currency);
  const setC = (k) => (e) => setCr({ ...cr, [k]: e.target.value, ...(k === "currency" ? { invoiceId: "" } : {}) });

  return (
    <Modal title="إرجاع بضاعة أمانة إلى التاجر" onClose={onClose} wide>
      {step === "select" ? (
        <div className="form">
          <p className="muted small-note">تظهر هنا بضاعة الأمانة العائدة لهذا التاجر فقط والمتوفرة فعلاً. اختر الكميات المراد إرجاعها من كل رتل (من المحل أو المستودع).</p>
          <div className="toolbar">
            <div className="search-bar grow" role="search"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="رقم الموديل أو الاسم أو رقم الرتل أو المقاس" aria-label="بحث في بضاعة الأمانة" /></div>
            <select aria-label="الموقع" value={location} onChange={(e) => setLocation(e.target.value)}><option value="">المحل والمستودع</option><option value="shop">المحل</option><option value="warehouse">المستودع</option></select>
          </div>
          <ErrorBanner error={list.error} onRetry={list.reload} />
          {list.loading && !list.data ? <Loading /> : series.length === 0 ? <EmptyState title="لا توجد بضاعة أمانة مطابقة" text="لا يوجد لهذا التاجر بضاعة أمانة متوفرة بهذه المواصفات." /> : (
            <div className="ret-list">
              {series.map((s) => (
                <div key={s.id} className="ret-series">
                  <header>
                    <span><b className="mono">{s.seriesNo}</b> · <span className="mono strong">{s.modelNumber}</span> {s.name} · {PLACE[s.location]}</span>
                    <span className="muted small-note">{s.remaining} قطعة · {s.value == null ? <span className="pill consign">بلا سعر اتفاق</span> : money(s.value.amount, s.value.currency)}</span>
                  </header>
                  <div className="ret-sizes">
                    {[...s.sizes].sort((a, b) => compareSizes(a.size, b.size)).map((x) => (
                      <label key={x.size} className="ret-size">
                        <span className="size-chip">{x.size}</span>
                        <input type="number" min="0" max={x.qty} value={pick[`${s.id}|${x.size}`] || ""} placeholder={`0/${x.qty}`} onChange={(e) => setQty(s, x.size, x.qty, e.target.value)} aria-label={`كمية المقاس ${x.size} من ${s.seriesNo}`} />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="actions">
            <span className="muted">المحدد: <b>{totalQty}</b> قطعة{totalQty > 0 && <> · {valueText || "بلا قيمة اتفاق"} بأسعار الاتفاق{unpriced > 0 && ` (+${unpriced} بلا سعر)`}</>}</span>
            <button className="btn ghost" onClick={onClose}>إلغاء</button>
            <button className="btn primary" disabled={!totalQty} onClick={() => setStep("review")}>مراجعة الإرجاع</button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
          <h3>ملخص الإرجاع</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>الرتل</th><th>الموديل</th><th>الموقع</th><th>المقاس</th><th className="num">الكمية</th><th className="num">قيمة الاتفاق</th></tr></thead>
              <tbody>
                {detailed.map((l) => (
                  <tr key={`${l.seriesId}|${l.size}`}>
                    <td className="mono">{l.s.seriesNo}</td><td><span className="mono strong">{l.s.modelNumber}</span> {l.s.name}</td><td>{PLACE[l.s.location]}</td>
                    <td><span className="size-chip">{l.size}</span></td><td className="num">{l.qty}</td><td className="num">{l.s.price ? money(l.qty * l.s.price.amount, l.s.price.currency) : "بلا سعر"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={4}>المجموع</th><td className="num"><b>{totalQty}</b></td><td className="num"><b>{valueText || "—"}</b></td></tr></tfoot>
            </table>
          </div>
          <Field label="سبب الإرجاع (إلزامي)"><input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} placeholder="مثال: الموديل لا يُباع" autoFocus /></Field>
          <label className="check"><input type="checkbox" checked={withCredit} onChange={(e) => setWithCredit(e.target.checked)} /> تسجيل ائتمان مالي مع الإرجاع (فقط إن كانت هذه القطع قد دخلت في التزام أو دُفع ثمنها)</label>
          {withCredit && (
            <div className="card">
              <MoneyFields f={cr} set={setC} amountLabel="مبلغ الائتمان" />
              <Field label="ربط بفاتورة بنفس العملة (اختياري)">
                <select value={cr.invoiceId} onChange={setC("invoiceId")}><option value="">بلا ربط (رصيد دائن متاح)</option>{open.map((i) => <option key={i.id} value={i.id}>{i.invoiceNo} — متبقٍ {money(i.outstanding, i.currency)}</option>)}</select>
              </Field>
              <Field label="ملاحظة"><input value={cr.note} onChange={setC("note")} maxLength={500} /></Field>
              <p className="muted small-note">الائتمان قيد حسابي فقط ولا يحرّك أي صندوق.</p>
            </div>
          )}
          {!withCredit && <p className="muted small-note">لن يتغيّر حساب التاجر المالي: الإرجاع يُنقص بضاعة الأمانة لديك فقط ويُسجَّل كحركة مخزون.</p>}
          <ErrorBanner error={error} />
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setStep("select")} disabled={busy}>رجوع</button>
            <button className="btn primary" disabled={busy || !reason.trim() || (withCredit && !(Number(cr.amount) > 0))}>تأكيد الإرجاع</button>
          </div>
        </form>
      )}
      {confirm && (
        <ConfirmDialog title="تأكيد إرجاع البضاعة للتاجر" confirmLabel="إرجاع البضاعة" danger busy={busy}
          message={`ستُخصم ${totalQty} قطعة من المخزون وتُسلَّم للتاجر${withCredit ? ` مع قيد ائتمان ${money(Number(cr.amount), cr.currency)} (حسابي بلا نقد)` : ""}. لا يمكن التراجع عن حركة المخزون.`}
          onCancel={() => setConfirm(false)} onConfirm={() => { run(() => api.post(`/suppliers/${supplierId}/returns`, body())); setConfirm(false); }} />
      )}
    </Modal>
  );
}
