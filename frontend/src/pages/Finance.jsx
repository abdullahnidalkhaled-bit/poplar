import PageHeader from "../components/ui/PageHeader.jsx";
import ExpenseFormModal from "../components/finance/ExpenseFormModal.jsx";
import { useRef, useState } from "react";
import { api, qs } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import Modal from "../components/ui/Modal.jsx";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import Field from "../components/ui/Field.jsx";
import Pagination from "../components/ui/Pagination.jsx";
import { Alert, Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { money, num, newKey, todayStr, monthStr, monthRange, dayRange, timeZone, fmtDateTime, CUR_NAME, CASH_TYPE, dayStartIso, dayEndIso } from "../utils.js";

const TABS = [["dash", "لوحة المالية"], ["cash", "حركات الصندوقين"], ["expenses", "المصروفات"]];

// قسم عملة واحدة: كل رقم بعملته، بلا أي مجموع أو تحويل نحو العملة الأخرى
const Kpi = ({ k, v, s, tone, na }) => (
  <div className={`kpi ${tone || ""} ${na ? "na" : ""}`}>
    <div className="k">{k}</div>
    <div className="v">{na ? "غير متاح" : v}</div>
    {s && <div className="s">{s}</div>}
  </div>
);

function Delta({ cur, now, prev }) {
  if (prev == null || now == null) return <span className="muted">—</span>;
  const d = Math.round((now - prev) * 100) / 100;
  if (d === 0) return <span className="muted">دون تغيير</span>;
  return <span className={d > 0 ? "delta-up" : "delta-down"}>{d > 0 ? "▲" : "▼"} {money(Math.abs(d), cur)}</span>;
}

function FlowChart({ rows, cur }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.in, r.out]));
  if (!rows.length) return <p className="muted">لا حركات نقد في هذه الفترة.</p>;
  return (
    <>
      <div className="legend"><span><i className="in" />وارد ({CUR_NAME[cur]})</span><span><i className="out" />صادر ({CUR_NAME[cur]})</span></div>
      <div className="chart-flow" role="img" aria-label={`واردات وصادرات يومية بعملة ${CUR_NAME[cur]} فقط`}>
        {rows.map((r) => (
          <div key={r.day} className="flow-col" title={`${r.day}\nوارد ${money(r.in, cur)}\nصادر ${money(r.out, cur)}`}>
            <div className="flow-pair">
              <div className="flow-bar in" style={{ height: `${Math.max(2, (r.in / max) * 100)}%` }} />
              <div className="flow-bar out" style={{ height: `${Math.max(2, (r.out / max) * 100)}%` }} />
            </div>
            <span>{r.day.slice(5)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function CurrencySection({ d }) {
  const c = d.currency;
  const m = (v) => money(v, c);
  const unavailable = d.netProfit == null;
  return (
    <section className="cur-section" aria-label={`قسم ${CUR_NAME[c]}`}>
      <div className="cur-head"><h2>صندوق {CUR_NAME[c]}</h2><span className={`cur-badge ${c === "SYP" ? "syp" : ""}`}>{c === "USD" ? "USD $" : "SYP ل.س"}</span></div>

      <h3>النقد (من دفتر الصندوق فقط)</h3>
      <div className="kpis">
        <Kpi k="الرصيد الحالي" v={m(d.balance)} s={`من ${num(d.balanceAllTime.movements)} حركة`} tone={d.balance < 0 ? "bad" : ""} />
        <Kpi k="واردات الفترة" v={m(d.cash.in)} tone="good" />
        <Kpi k="صادرات الفترة" v={m(d.cash.out)} />
        <Kpi k="صافي نقد الفترة" v={m(d.cash.net)} s="وارد − صادر (ليس ربحاً)" tone={d.cash.net < 0 ? "bad" : ""} />
      </div>
      {d.legacy.invoicesWithoutCash > 0 && (
        <div className="banner warn" role="status"><span>{num(d.legacy.invoicesWithoutCash)} فاتورة {c === "USD" ? "بالدولار" : "بالليرة"} سابقة لا حركات نقد لها (بيانات تاريخية). لم يُرحَّل شيء تلقائياً: أدخل الرصيد الافتتاحي لهذا الصندوق من تبويب «حركات الصندوقين».</span></div>
      )}

      <h3>المبيعات والربحية (محاسبة مستقلة عن النقد)</h3>
      <div className="kpis">
        <Kpi k="إيراد المبيعات" v={m(d.revenue)} s={`${num(d.invoices)} فاتورة · ${num(d.pieces)} قطعة`} />
        <Kpi k="المرتجعات" v={m(d.refunds)} s={`${num(d.returnsCount)} عملية`} />
        <Kpi k="صافي الإيراد" v={m(d.netRevenue)} s="الإيراد − المرتجعات" />
        <Kpi k="تكلفة البضاعة المباعة" v={d.cogs == null ? "" : m(d.cogs)} na={d.cogs == null} s={d.cogs == null ? "التكلفة مسجّلة بالدولار" : "بعد عكس المرتجع السليم"} />
        <Kpi k="مجمل الربح" v={d.grossProfit == null ? "" : m(d.grossProfit)} na={d.grossProfit == null} tone={d.grossProfit == null ? "" : d.grossProfit < 0 ? "bad" : "good"} />
        <Kpi k="المصروفات التشغيلية" v={m(d.expenses)} />
        {c === "USD" && <Kpi k="خسائر إتلاف المخزون" v={m(d.writeOffs)} s={`${num(d.writeOffPieces || 0)} قطعة (تكلفة)`} />}
        <Kpi k="صافي الربح" v={unavailable ? "" : m(d.netProfit)} na={unavailable} tone={unavailable ? "" : d.netProfit < 0 ? "bad" : "good"} s={unavailable ? "غير متاح بالليرة" : "مجمل الربح − المصروفات − الإتلاف"} />
      </div>
      {d.unavailable && <p className="hint-box">{d.unavailable}</p>}
      {d.estimate && (
        <div className="est-box">
          <b>تقدير منفصل (غير داخل في أي مجموع):</b> تكلفة البضاعة المباعة ≈ {m(d.estimate.cogs)} · مجمل الربح ≈ {m(d.estimate.grossProfit)} · صافي الربح ≈ {m(d.estimate.netProfit)}.
          محسوب من تكلفة المخزون بالدولار × سعر صرف كل فاتورة نفسها وقت البيع، بلا إتلاف مخزون. للاستئناس فقط.
        </div>
      )}

      <h3>الموردون والزبائن</h3>
      <div className="kpis">
        <Kpi k="دفعات الموردين (صافي الفترة)" v={m(d.supplierPayments)} s="نقد خرج فعلاً" />
        <Kpi k="مستحق للموردين (حالياً)" v={m(d.supplierPayable)} s="التزام لم يُدفع بعد" tone={d.supplierPayable > 0 ? "bad" : ""} />
        <Kpi k="سلف لدى الموردين" v={m(d.supplierAdvances)} s="نقد دُفع ولم يُخصَّص" />
        <Kpi k="ذمم الزبائن" v="" na s={d.customerReceivables.reason} />
      </div>

      <h3>المقارنة بالفترة السابقة المماثلة ({c === "USD" ? "دولار" : "ليرة"} فقط)</h3>
      <div className="table-wrap">
        <table className="table-cards">
          <thead><tr><th>المؤشر</th><th className="num">الفترة الحالية</th><th className="num">الفترة السابقة</th><th>التغيّر</th></tr></thead>
          <tbody>
            <tr><th scope="row" data-label="المؤشر">صافي الإيراد</th><td data-label="الفترة الحالية" className="num">{m(d.netRevenue)}</td><td data-label="الفترة السابقة" className="num">{m(d.previous.netRevenue)}</td><td data-label="التغيّر"><Delta cur={c} now={d.netRevenue} prev={d.previous.netRevenue} /></td></tr>
            <tr><th scope="row" data-label="المؤشر">المصروفات</th><td data-label="الفترة الحالية" className="num">{m(d.expenses)}</td><td data-label="الفترة السابقة" className="num">{m(d.previous.expenses)}</td><td data-label="التغيّر"><Delta cur={c} now={d.expenses} prev={d.previous.expenses} /></td></tr>
            <tr><th scope="row" data-label="المؤشر">صافي النقد</th><td data-label="الفترة الحالية" className="num">{m(d.cash.net)}</td><td data-label="الفترة السابقة" className="num">{m(d.previous.cashNet)}</td><td data-label="التغيّر"><Delta cur={c} now={d.cash.net} prev={d.previous.cashNet} /></td></tr>
            <tr><th scope="row" data-label="المؤشر">صافي الربح</th><td data-label="الفترة الحالية" className="num">{d.netProfit == null ? "غير متاح" : m(d.netProfit)}</td><td data-label="الفترة السابقة" className="num">{d.previous.netProfit == null ? "غير متاح" : m(d.previous.netProfit)}</td><td data-label="التغيّر"><Delta cur={c} now={d.netProfit} prev={d.previous.netProfit} /></td></tr>
          </tbody>
        </table>
      </div>

      <h3>حركة النقد اليومية</h3>
      <FlowChart rows={d.daily} cur={c} />

      {d.expensesByCategory.length > 0 && (
        <>
          <h3>المصروفات حسب الفئة</h3>
          <div className="table-wrap"><table className="table-cards"><thead><tr><th>الفئة</th><th className="num">المبلغ</th></tr></thead>
            <tbody>{d.expensesByCategory.map((e) => <tr key={e.category}><td data-label="الفئة">{e.category}</td><td data-label="المبلغ" className="num">{m(e.amount)}</td></tr>)}</tbody></table></div>
        </>
      )}
    </section>
  );
}

function Dashboard({ range }) {
  const [cur, setCur] = useState("SYP");
  const { data, error, loading, reload } = useAsync(() => api.get(`/finance/dashboard${qs({ from: range.from, to: range.to, tz: timeZone() })}`), [range.from, range.to]);
  return (
    <div>
      <div className="seg cur-tabs" role="tablist" aria-label="اختر الصندوق">
        <button role="tab" aria-selected={cur === "SYP"} className={cur === "SYP" ? "on" : ""} onClick={() => setCur("SYP")}>الليرة السورية</button>
        <button role="tab" aria-selected={cur === "USD"} className={cur === "USD" ? "on" : ""} onClick={() => setCur("USD")}>الدولار الأمريكي</button>
      </div>
      <p className="hint-box">الصندوقان مستقلان تماماً: لا يوجد مجموع مشترك ولا تحويل بين الليرة والدولار. الرصيد من حركات النقد الفعلية فقط؛ الفواتير والمستحقات لا تحرّك النقد حتى الدفع.</p>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && <CurrencySection d={data[cur]} />}
      <details className="hint-box">
        <summary>تعريفات المؤشرات</summary>
        <p>إيراد المبيعات = إجمالي الفواتير المكتملة بتلك العملة (الملغاة مستثناة). صافي الإيراد = الإيراد − المرتجعات. تكلفة البضاعة = تكلفة الفواتير − تكلفة القطع السليمة المرتجعة (بالدولار فقط: تكلفة المخزون مسجّلة بالدولار). مجمل الربح = صافي الإيراد − التكلفة. صافي الربح = مجمل الربح − المصروفات التشغيلية − خسائر الإتلاف. دفعات الموردين تقلّل النقد ولا تُعدّ مصروفاً لحظة الدفع لأن الالتزام معترف به عند الفاتورة/التسوية. كل ما لا يمكن حسابه بدقة يظهر «غير متاح».</p>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ حركات الصندوقين
function ManualCashModal({ onClose, onDone }) {
  const key = useRef(newKey());
  const [f, setF] = useState({ currency: "SYP", direction: "in", amount: "", note: "" });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { onDone(await api.post("/finance/cash", { currency: f.currency, direction: f.direction, amount: Number(f.amount), note: f.note.trim(), idempotencyKey: key.current })); } catch (e) { setError(e); setBusy(false); setConfirm(false); }
  };
  return (
    <Modal title="إيداع / سحب يدوي (رصيد افتتاحي أو تصحيح)" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
        <p className="muted small-note">يؤثر على صندوق العملة المختارة فقط. للأرصدة الافتتاحية والإيداعات/السحوبات الخارجة عن المبيعات والمصروفات. يُعكس بحركة عكسية ولا يُحذف.</p>
        <div className="grid3">
          <Field label="الصندوق"><select value={f.currency} onChange={set("currency")}><option value="SYP">الليرة السورية</option><option value="USD">الدولار الأمريكي</option></select></Field>
          <Field label="الاتجاه"><select value={f.direction} onChange={set("direction")}><option value="in">إيداع (وارد)</option><option value="out">سحب (صادر)</option></select></Field>
          <Field label={`المبلغ (${f.currency === "USD" ? "$" : "ل.س"})`} hint={f.currency === "SYP" ? "عدد صحيح" : "خانتان عشريتان كحد أقصى"}><input type="number" min="0" step={f.currency === "SYP" ? "1" : "0.01"} value={f.amount} onChange={set("amount")} required dir="ltr" /></Field>
        </div>
        <Field label="البيان (إلزامي)"><input value={f.note} onChange={set("note")} required maxLength={300} placeholder="مثال: رصيد افتتاحي" /></Field>
        <ErrorBanner error={error} />
        <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>إلغاء</button><button className="btn primary" disabled={busy || !(Number(f.amount) > 0) || !f.note.trim()}>مراجعة</button></div>
      </form>
      {confirm && <ConfirmDialog title="تأكيد الحركة" confirmLabel="تسجيل" busy={busy} message={`سيُ${f.direction === "in" ? "ضاف" : "خصم"} ${money(Number(f.amount), f.currency)} ${f.direction === "in" ? "إلى" : "من"} صندوق ${CUR_NAME[f.currency]} فقط.`} onCancel={() => setConfirm(false)} onConfirm={submit} />}
    </Modal>
  );
}

function ReasonModal({ title, text, url, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try { onDone(await api.post(url, { reason: reason.trim() })); } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={run}>
        <p>{text}</p>
        <Field label="السبب (إلزامي)"><input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} autoFocus /></Field>
        <ErrorBanner error={error} />
        <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>إلغاء</button><button className="btn danger" disabled={busy || !reason.trim()}>{busy ? "جارٍ التنفيذ..." : "عكس"}</button></div>
      </form>
    </Modal>
  );
}

function CashTab({ range, onChanged }) {
  const [f, setF] = useState({ currency: "", type: "", page: 1 });
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState("");
  const { data, error, loading, reload } = useAsync(() => api.get(`/finance/cash${qs({ currency: f.currency, type: f.type, from: range.from, to: range.to, page: f.page, limit: 25 })}`), [f.currency, f.type, f.page, range.from, range.to]);
  const done = (msg) => () => { setModal(null); setNotice(msg); reload(); onChanged(); };
  return (
    <div>
      {notice && <Alert tone="ok" title="تم" action={<button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button>}>{notice}</Alert>}
      <div className="toolbar">
        <select aria-label="الصندوق" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value, page: 1 })}><option value="">الصندوقان (كل حركة بعملتها)</option><option value="SYP">الليرة السورية</option><option value="USD">الدولار الأمريكي</option></select>
        <select aria-label="النوع" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, page: 1 })}><option value="">كل الأنواع</option>{Object.entries(CASH_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="btn primary" onClick={() => setModal({ kind: "manual" })}>إيداع / سحب يدوي</button>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (data?.items.length || 0) === 0 ? <EmptyState title="لا حركات نقد في هذه الفترة" /> : (
        <>
          <div className="table-wrap" aria-busy={loading}>
            <table className="table-cards">
              <thead><tr><th>التاريخ</th><th>المرجع</th><th>الصندوق</th><th>النوع</th><th>المصدر</th><th className="num">المبلغ</th><th>بواسطة</th><th /></tr></thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id} className={m.reversed ? "row-reversed" : ""}>
                    <td data-label="التاريخ" className="nowrap">{fmtDateTime(m.date)}</td>
                    <td data-label="المرجع" className="mono">{m.ref}</td>
                    <td data-label="الصندوق"><span className={`cur-badge ${m.currency === "SYP" ? "syp" : ""}`}>{m.currency === "USD" ? "دولار" : "ليرة"}</span></td>
                    <td data-label="النوع">{CASH_TYPE[m.type] || m.type}<div className="small-note muted">{m.note}</div></td>
                    <td data-label="المصدر" className="mono">{m.source.ref}</td>
                    <td data-label="المبلغ" className={`num ${m.direction === "in" ? "amount-ok" : "amount-due"}`}>{m.direction === "in" ? "+" : "−"}{money(m.amount, m.currency)}</td>
                    <td data-label="بواسطة">{m.createdBy}</td>
                    <td className="row-actions">{m.source.kind === "manual" && !m.reversed && !m.reverses && <button className="btn small ghost" onClick={() => setModal({ kind: "reverse", m })}>عكس</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={(p) => setF({ ...f, page: p })} />
        </>
      )}
      {modal?.kind === "manual" && <ManualCashModal onClose={() => setModal(null)} onDone={done("تم تسجيل الحركة في صندوق عملتها.")} />}
      {modal?.kind === "reverse" && <ReasonModal title={`عكس الحركة ${modal.m.ref}`} text={`ستُنشأ حركة عكسية بنفس العملة (${CUR_NAME[modal.m.currency]}) ويبقى الأصل في السجل.`} url={`/finance/cash/${modal.m.id}/reverse`} onClose={() => setModal(null)} onDone={done("تم عكس الحركة.")} />}
    </div>
  );
}

// ------------------------------------------------------------------ المصروفات
function ExpensesTab({ range, onChanged }) {
  const [f, setF] = useState({ currency: "", page: 1 });
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState("");
  const { data, error, loading, reload } = useAsync(() => api.get(`/finance/expenses${qs({ currency: f.currency, from: range.from, to: range.to, page: f.page, limit: 25 })}`), [f.currency, f.page, range.from, range.to]);
  const done = (msg) => (out) => { setModal(null); setNotice(out?.duplicate ? "هذه العملية سُجّلت مسبقاً." : msg); reload(); onChanged(); };
  return (
    <div>
      {notice && <Alert tone="ok" title="تم" action={<button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button>}>{notice}</Alert>}
      <div className="toolbar">
        <select aria-label="العملة" value={f.currency} onChange={(e) => setF({ currency: e.target.value, page: 1 })}><option value="">العملتان (كل مصروف بعملته)</option><option value="SYP">الليرة السورية</option><option value="USD">الدولار الأمريكي</option></select>
        <button className="btn primary" onClick={() => setModal({ kind: "new" })}>مصروف جديد</button>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (data?.items.length || 0) === 0 ? <EmptyState title="لا مصروفات في هذه الفترة" text="سجّل المصروفات التشغيلية ليظهر أثرها على صندوقها وعلى صافي الربح." /> : (
        <>
          <div className="table-wrap" aria-busy={loading}>
            <table className="table-cards">
              <thead><tr><th>التاريخ</th><th>المرجع</th><th>الفئة</th><th>الوصف</th><th className="num">المبلغ</th><th>الحالة</th><th /></tr></thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id} className={e.status === "reversed" ? "row-reversed" : ""}>
                    <td data-label="التاريخ" className="nowrap">{new Date(e.date).toLocaleDateString("en-GB")}</td>
                    <td data-label="المرجع" className="mono">{e.ref}</td>
                    <td data-label="الفئة">{e.category}</td>
                    <td data-label="الوصف">{e.description}{e.reversal && <div className="small-note muted">معكوس: {e.reversal.reason}</div>}</td>
                    <td data-label="المبلغ" className="num">{money(e.amount, e.currency)}</td>
                    <td data-label="الحالة">{e.status === "reversed" ? <span className="pill rev">معكوس</span> : <span className="pill acct-settled">مسجَّل</span>}</td>
                    <td className="row-actions">{e.status === "posted" && <button className="btn small ghost" onClick={() => setModal({ kind: "reverse", e })}>عكس</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pages={data.pages} total={data.total} onChange={(p) => setF({ ...f, page: p })} />
        </>
      )}
      {modal?.kind === "new" && <ExpenseFormModal onClose={() => setModal(null)} onDone={done("تم تسجيل المصروف.")} />}
      {modal?.kind === "reverse" && <ReasonModal title={`عكس المصروف ${modal.e.ref}`} text={`سيُعاد ${money(modal.e.amount, modal.e.currency)} إلى صندوق ${CUR_NAME[modal.e.currency]} بحركة عكسية ويبقى المصروف في السجل.`} url={`/finance/expenses/${modal.e.id}/reverse`} onClose={() => setModal(null)} onDone={done("تم عكس المصروف.")} />}
    </div>
  );
}

// ------------------------------------------------------------------ الصفحة
export default function Finance() {
  const [tab, setTab] = useState("dash");
  const [mode, setMode] = useState("month");
  const [day, setDay] = useState(todayStr());
  const [month, setMonth] = useState(monthStr());
  const [custom, setCustom] = useState({ from: todayStr(), to: todayStr() });
  const [tick, setTick] = useState(0);
  const range = mode === "day" ? dayRange(day) : mode === "month" ? monthRange(month) : { from: dayStartIso(custom.from), to: dayEndIso(custom.to) };
  const key = `${range.from}|${range.to}|${tick}`;
  return (
    <div>
      <PageHeader title="المالية">
          <div className="seg" role="group" aria-label="نوع الفترة">
            {[["day", "يوم"], ["month", "شهر"], ["custom", "فترة"]].map(([k, l]) => <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>{l}</button>)}
          </div>
          {mode === "day" && <input type="date" aria-label="اليوم" value={day} onChange={(e) => setDay(e.target.value)} />}
          {mode === "month" && <input type="month" aria-label="الشهر" value={month} onChange={(e) => setMonth(e.target.value)} />}
          {mode === "custom" && <><input type="date" aria-label="من" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /><input type="date" aria-label="إلى" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></>}
      </PageHeader>
      <div className="seg sup-tabs" role="tablist" aria-label="أقسام المالية">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "dash" && <Dashboard key={key} range={range} />}
      {tab === "cash" && <CashTab range={range} onChanged={() => setTick((t) => t + 1)} />}
      {tab === "expenses" && <ExpensesTab range={range} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  );
}
