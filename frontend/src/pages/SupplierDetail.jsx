import PageHeader from "../components/ui/PageHeader.jsx";
import ActionMenu from "../components/ui/ActionMenu.jsx";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, qs } from "../api.js";
import useAsync from "../hooks/useAsync.js";
import Pagination from "../components/ui/Pagination.jsx";
import ConfirmDialog from "../components/ui/ConfirmDialog.jsx";
import { Alert, Loading, ErrorBanner, EmptyState } from "../components/ui/feedback.jsx";
import { SupplierFormModal, InvoiceModal, EntryModal, AllocateModal, ReasonModal, PriceModal, SettleModal, ReturnConsignmentModal } from "../components/suppliers/SupplierForms.jsx";
import { StatusPill, Dual } from "./Suppliers.jsx";
import { num, money, fmtDateTime, PLACE, ENTRY_TYPE, INVOICE_KIND, PAY_STATUS, CUR_NAME, netText, dayStartIso, dayEndIso } from "../utils.js";

const TABS = [["overview", "نظرة عامة"], ["invoices", "فواتير التاجر"], ["credits", "الدفعات والسلف"], ["ledger", "كشف الحساب"], ["consignment", "بضاعة الأمانة"], ["settlements", "تسويات الأمانة"], ["returns", "الإرجاعات"]];
const dateOnly = (iso) => new Date(iso).toLocaleDateString("en-GB");
const priceText = (p) => (p ? money(p.amount, p.currency) : null);
const valText = (v) => ["USD", "SYP"].filter((c) => v?.[c] > 0).map((c) => money(v[c], c)).join(" + ") || "—";

// المراكز الثلاثة لعملة واحدة (مستحق إجمالي / سلف متاحة / صافٍ): كل عملة حساب مستقل
function Positions({ cur, p, open, credits }) {
  return (
    <section className="cur-section" aria-label={`حساب ${CUR_NAME[cur]}`}>
      <div className="cur-head"><h2>حساب {CUR_NAME[cur]}</h2><span className={`cur-badge ${cur === "SYP" ? "syp" : ""}`}>{cur === "USD" ? "USD $" : "SYP ل.س"}</span></div>
      <div className="positions">
        <div className="position payable"><h3>المستحق الإجمالي للتاجر</h3><div className={`big ${p.grossPayable > 0 ? "amount-due" : ""}`}>{money(p.grossPayable, cur)}</div><span className="sub">فواتير بهذه العملة غير مسددة · {open} مفتوحة</span></div>
        <div className="position advance"><h3>السلف والأرصدة الدائنة المتاحة</h3><div className={`big ${p.advance > 0 ? "amount-adv" : ""}`}>{money(p.advance, cur)}</div><span className="sub">لم تُخصَّص على فواتير · {credits} رصيد</span></div>
        <div className="position net"><h3>الصافي</h3><div className="big">{netText(p.net, cur)}</div><span className="sub">المستحق − السلف المتاحة (بهذه العملة فقط)</span></div>
      </div>
    </section>
  );
}

export default function SupplierDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState("overview");
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);
  const [filters, setFilters] = useState({ type: "", currency: "", from: "", to: "", page: 1 });
  const [picked, setPicked] = useState({});
  const [priceSel, setPriceSel] = useState({});
  const [toggling, setToggling] = useState(false);
  const [actionErr, setActionErr] = useState(null);

  const ledger = useAsync(() => api.get(`/suppliers/${id}/ledger${qs({ type: filters.type, currency: filters.currency, from: filters.from && dayStartIso(filters.from), to: filters.to && dayEndIso(filters.to), page: filters.page, limit: 25 })}`), [id, tick, JSON.stringify(filters)]);
  const invoices = useAsync(() => api.get(`/suppliers/${id}/invoices`), [id, tick]);
  const alloc = useAsync(() => api.get(`/suppliers/${id}/allocations`), [id, tick]);
  const consignment = useAsync(() => api.get(`/suppliers/${id}/consignment`), [id, tick]);
  const eligible = useAsync(() => api.get(`/suppliers/${id}/settlements/eligible`), [id, tick]);
  const settlements = useAsync(() => api.get(`/suppliers/${id}/settlements`), [id, tick]);
  const returns = useAsync(() => api.get(`/suppliers/${id}/returns`), [id, tick]);

  const sup = ledger.data?.supplier;
  const sum = ledger.data?.summary;
  const close = () => setModal(null);
  const refresh = () => setTick((t) => t + 1);
  const done = (msg) => (out) => {
    close(); setPicked({}); setPriceSel({}); setActionErr(null);
    setNotice(out?.duplicate ? "هذه العملية سُجّلت مسبقاً ولم تُكرَّر." : msg);
    refresh();
  };
  const setFilter = (patch) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  const act = async (fn, msg) => { setToggling(true); setActionErr(null); try { await fn(); setNotice(msg); refresh(); close(); } catch (e) { setActionErr(e); close(); } finally { setToggling(false); } };

  if (ledger.loading && !ledger.data) return <Loading />;
  if (ledger.error && !ledger.data) return <div><Link to="/suppliers" className="btn ghost small">← التجار</Link><ErrorBanner error={ledger.error} onRetry={ledger.reload} /></div>;
  const c = consignment.data;
  const credits = alloc.data?.credits || [];
  const availableCredits = credits.filter((x) => x.available > 0);
  const openInvoices = (invoices.data?.items || []).filter((i) => i.status === "posted" && i.outstanding > 0);
  const eligRows = (eligible.data?.items || []).filter((r) => r.settleable > 0 || r.overSettled);
  const pickedLines = eligRows.filter((r) => picked[`${r.seriesId}|${r.size}`]).map((r) => ({ ...r, qty: picked[`${r.seriesId}|${r.size}`] }));
  const priceRows = (c?.series || []).filter((s) => priceSel[s.id]);
  const openBy = (cur) => openInvoices.filter((i) => i.currency === cur).length;
  const credBy = (cur) => availableCredits.filter((x) => x.currency === cur).length;

  return (
    <div>
      <PageHeader
        crumbs={[{ to: "/suppliers", label: "حسابات التجار" }, { label: sup.name }]}
        title={<>{sup.name} {!sup.active && <span className="pill cancelled">معطّل</span>} <StatusPill status={sum.status} /></>}
        sub={<span dir="auto">{[sup.phone && `⁦${sup.phone.replace(/\s+/g, "")}⁩`, sup.address].filter(Boolean).join(" · ")}{sup.notes ? ` — ${sup.notes}` : ""}</span>}
        more={[
          { label: "تعديل بيانات التاجر", onClick: () => setModal({ kind: "edit" }) },
          { label: sup.active ? "تعطيل التاجر" : "تفعيل التاجر", onClick: () => setModal({ kind: "toggle" }), danger: sup.active },
        ]}
      />

      {notice && <Alert tone="ok" title="تم" action={<button className="btn small ghost" onClick={() => setNotice("")}>إخفاء</button>}>{notice}</Alert>}
      <ErrorBanner error={actionErr} />

      <div className="sup-actions">
        <button className="btn primary" disabled={!sup.active} onClick={() => setModal({ kind: "invoice" })}>تسجيل فاتورة شراء</button>
        <button className="btn" disabled={!sup.active} onClick={() => setModal({ kind: "payment" })}>تسجيل دفعة</button>
        <button className="btn" disabled={!sup.active} onClick={() => setModal({ kind: "advance" })}>تسجيل سلفة</button>
        {sup.active && <ActionMenu label="قيود أخرى" items={[
          { label: "إشعار دائن", onClick: () => setModal({ kind: "credit" }) },
          { label: "تسوية مدينة", onClick: () => setModal({ kind: "adjustment" }) },
        ]} />}
      </div>

      <div className="seg sup-tabs" role="tablist" aria-label="أقسام حساب التاجر">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {/* ------------------------------------------------ نظرة عامة */}
      {tab === "overview" && (
        <section>
          <p className="hint-box">الدولار والليرة حسابان مستقلان تماماً: لكل عملة مراكزها الخاصة، ولا يُجمع أو يُحوَّل شيء بينهما. الفاتورة والتسوية التزامان فقط؛ النقد يخرج من صندوق عملة الدفع عند تسجيل دفعة أو سلفة.</p>
          <Positions cur="SYP" p={sum.positions.SYP} open={openBy("SYP")} credits={credBy("SYP")} />
          <Positions cur="USD" p={sum.positions.USD} open={openBy("USD")} credits={credBy("USD")} />
          <p className="hint-box">سياسة التخصيص: الدفعة المرتبطة بفاتورة بنفس عملتها تُخصَّص عليها فوراً. السلف والدفعات غير المرتبطة تبقى «متاحة» ولا تُنقص المستحق إلا بتخصيص صريح (يدوي أو «تطبيق تلقائي» الأقدم فالأحدث وبنفس العملة) يُسجَّل في سجل التخصيص ويمكن تحريره. التخصيص عبر عملتين يتطلب تأكيداً ومبلغين وسعر صرف مُدخَل. لا يوجد تقييم دولاري لحسابات الليرة.</p>

          <div className="section-title"><h3>إجماليات بعملة كل قيد</h3><span className="muted small-note">القيم الأصلية، لا تُجمع عملة مع أخرى</span></div>
          <div className="table-wrap">
            <table className="table-cards">
              <thead><tr><th>العملة</th><th className="num">فواتير وتسويات مدينة</th><th className="num">أرصدة دائنة (دفعات/سلف/إشعارات)</th><th className="num">مخصَّص على فواتير</th></tr></thead>
              <tbody>{["SYP", "USD"].map((cur) => <tr key={cur}><th scope="row" data-label="العملة">{CUR_NAME[cur]}</th><td data-label="فواتير وتسويات مدينة" className="num">{money(sum.byCurrency[cur].invoiced, cur)}</td><td data-label="أرصدة دائنة" className="num">{money(sum.byCurrency[cur].credits, cur)}</td><td data-label="مخصَّص على فواتير" className="num">{money(sum.byCurrency[cur].allocatedToInvoices, cur)}</td></tr>)}</tbody>
            </table>
          </div>

          <div className="section-title"><h3>فواتير مفتوحة</h3><button className="btn small" disabled={!availableCredits.length || !openInvoices.length} onClick={() => setModal({ kind: "autoAllocate" })}>تطبيق تلقائي للسلف (بنفس العملة)</button></div>
          {openInvoices.length === 0 ? <p className="muted">لا توجد فواتير مفتوحة.</p> : (
            <div className="table-wrap"><table className="table-cards">
              <thead><tr><th>الفاتورة</th><th>الاستحقاق</th><th className="num">القيمة</th><th className="num">مخصَّص</th><th className="num">المتبقي</th></tr></thead>
              <tbody>{openInvoices.map((i) => (
                <tr key={i.id}><td data-label="الفاتورة" className="mono strong">{i.invoiceNo}</td><td data-label="الاستحقاق">{i.dueDate ? dateOnly(i.dueDate) : "—"}{i.overdue && <> <span className="pill pay-unpaid">متأخرة</span></>}</td>
                  <td data-label="القيمة" className="num">{money(i.amount, i.currency)}</td><td data-label="مخصَّص" className="num">{money(i.allocated, i.currency)}</td><td data-label="المتبقي" className="num amount-due">{money(i.outstanding, i.currency)}</td></tr>
              ))}</tbody></table></div>
          )}

          <div className="section-title"><h3>أرصدة دائنة متاحة</h3></div>
          {availableCredits.length === 0 ? <p className="muted">لا توجد سلف أو دفعات غير مطبّقة.</p> : (
            <div className="table-wrap"><table className="table-cards">
              <thead><tr><th>المرجع</th><th>النوع</th><th>التاريخ</th><th className="num">المبلغ</th><th className="num">المتاح</th><th /></tr></thead>
              <tbody>{availableCredits.map((x) => (
                <tr key={x.id}><td data-label="المرجع" className="mono">{x.ref}</td><td data-label="النوع">{ENTRY_TYPE[x.type]}</td><td data-label="التاريخ">{dateOnly(x.date)}</td>
                  <td data-label="المبلغ" className="num">{money(x.amount, x.currency)}</td><td data-label="المتاح" className="num amount-adv">{money(x.available, x.currency)}</td>
                  <td className="row-actions"><button className="btn small" disabled={!openInvoices.length} onClick={() => setModal({ kind: "allocate", credit: x.id })}>تخصيص على فاتورة</button></td></tr>
              ))}</tbody></table></div>
          )}
        </section>
      )}

      {/* ------------------------------------------------ الفواتير */}
      {tab === "invoices" && (
        <section>
          <ErrorBanner error={invoices.error} onRetry={invoices.reload} />
          {invoices.loading && !invoices.data ? <Loading /> : (invoices.data?.items.length || 0) === 0 ? <EmptyState title="لا توجد فواتير" text="سجّل فاتورة التاجر لتنشئ التزاماً مالياً موثّقاً." /> : (
            <div className="table-wrap">
              <table className="table-cards">
                <thead><tr><th>الفاتورة</th><th>النوع</th><th>التاريخ</th><th>الاستحقاق</th><th className="num">القيمة</th><th className="num">مخصَّص</th><th className="num">المتبقي</th><th>الحالة</th><th>إجراءات</th></tr></thead>
                <tbody>
                  {invoices.data.items.map((i) => (
                    <tr key={i.id} className={i.status === "reversed" ? "row-reversed" : ""}>
                      <td data-label="الفاتورة"><span className="mono strong">{i.invoiceNo}</span>{(i.shipmentRefs?.length > 0 || i.seriesNos.length > 0) && (
                        <div className="inv-links small-note muted">
                          {i.shipmentRefs?.length > 0 && <span title="الاستلام الذي أنشأ هذه الفاتورة">استلام <b className="mono">{i.shipmentRefs.join("، ")}</b></span>}
                          {i.seriesNos.length > 0 && <span title={i.seriesNos.join("، ")}>{i.seriesNos.length} {i.seriesNos.length === 1 ? "رتل" : "أرتال"}: <span className="mono">{i.seriesNos.slice(0, 2).join(" · ")}{i.seriesNos.length > 2 ? ` +${i.seriesNos.length - 2}` : ""}</span></span>}
                        </div>
                      )}</td>
                      <td data-label="النوع">{INVOICE_KIND[i.kind]}</td>
                      <td data-label="التاريخ" className="nowrap">{dateOnly(i.invoiceDate)}</td>
                      <td data-label="الاستحقاق" className="nowrap">{i.dueDate ? dateOnly(i.dueDate) : "—"}{i.overdue && <> <span className="pill pay-unpaid">متأخرة</span></>}</td>
                      <td data-label="القيمة" className="num">{money(i.amount, i.currency)}</td>
                      <td data-label="مخصَّص" className="num">{money(i.allocated, i.currency)}</td>
                      <td data-label="المتبقي" className={`num ${i.outstanding > 0 ? "amount-due" : ""}`}>{money(i.outstanding, i.currency)}</td>
                      <td data-label="الحالة">{i.status === "reversed" ? <span className="pill rev">معكوسة</span> : <span className={`pill pay-${i.payStatus}`}>{PAY_STATUS[i.payStatus]}</span>}</td>
                      <td data-label="إجراءات"><div className="inv-actions">
                        {i.status === "posted" && i.outstanding > 0 && (
                          <>
                            <button className="btn small" onClick={() => setModal({ kind: "payment", invoice: i })}>دفع</button>
                            <button className="btn small ghost" disabled={!availableCredits.some((x) => x.currency === i.currency)} title="تخصيص سلفة قائمة بنفس العملة" onClick={() => setModal({ kind: "allocate", invoice: i })}>تطبيق سلفة</button>
                            <button className="btn small ghost" onClick={() => setModal({ kind: "credit", invoice: i })}>إشعار دائن</button>
                          </>
                        )}
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------ الدفعات والسلف + سجل التخصيص */}
      {tab === "credits" && (
        <section>
          <ErrorBanner error={alloc.error} onRetry={alloc.reload} />
          <div className="section-title"><h3>الدفعات والسلف والإشعارات الدائنة</h3><button className="btn small" disabled={!availableCredits.length || !openInvoices.length} onClick={() => setModal({ kind: "autoAllocate" })}>تطبيق تلقائي (الأقدم فالأحدث، بنفس العملة)</button></div>
          {alloc.loading && !alloc.data ? <Loading /> : credits.length === 0 ? <EmptyState title="لا توجد دفعات أو سلف" /> : (
            <div className="table-wrap"><table className="table-cards">
              <thead><tr><th>المرجع / التاريخ</th><th>النوع</th><th>البيان</th><th className="num">المبلغ</th><th className="num">مخصَّص</th><th className="num">المتاح</th><th /></tr></thead>
              <tbody>{credits.map((x) => (
                <tr key={x.id}>
                  <td data-label="المرجع / التاريخ"><span className="mono">{x.ref}</span><div className="small-note muted">{dateOnly(x.date)}</div></td><td data-label="النوع">{ENTRY_TYPE[x.type]}{x.movesCash && <div className="small-note muted">خرج نقداً من صندوق {CUR_NAME[x.currency]}</div>}</td>
                  <td data-label="البيان">{x.note}<div className="small-note muted">{x.invoice?.invoiceNo && <>فاتورة {x.invoice.invoiceNo}</>}{x.crossCurrency && <> · عبر عملتين: سدّد {money(x.crossCurrency.settles, x.crossCurrency.invoiceCurrency)} بسعر مُدخَل {num(x.crossCurrency.rate)}</>}</div></td>
                  <td data-label="المبلغ" className="num">{money(x.amount, x.currency)}</td><td data-label="مخصَّص" className="num">{money(x.allocated, x.currency)}</td><td data-label="المتاح" className={`num ${x.available > 0 ? "amount-adv" : ""}`}>{money(x.available, x.currency)}</td>
                  <td className="row-actions">{x.available > 0 && <button className="btn small" disabled={!openInvoices.length} onClick={() => setModal({ kind: "allocate", credit: x.id })}>تخصيص</button>}</td>
                </tr>
              ))}</tbody></table></div>
          )}
          <div className="section-title"><h3>سجل التخصيص</h3><span className="muted small-note">للإلحاق فقط، ولا يُنشئ أي حركة نقد: التحرير يُنشئ سجلاً جديداً ويبقى الأصل</span></div>
          {(alloc.data?.items.length || 0) === 0 ? <p className="muted">لا توجد تخصيصات بعد.</p> : (
            <div className="table-wrap"><table className="table-cards">
              <thead><tr><th>المرجع</th><th>العملية</th><th>من → إلى</th><th className="num">على الفاتورة</th><th className="num">من الرصيد</th><th>المصدر</th><th>بواسطة</th><th /></tr></thead>
              <tbody>{alloc.data.items.map((a) => (
                <tr key={a.id} className={a.released ? "row-reversed" : ""}>
                  <td data-label="المرجع" className="mono">{a.ref}</td>
                  <td data-label="العملية">{a.kind === "apply" ? (a.needsReview ? <span className="pill pay-partial">للمراجعة</span> : a.released ? <span className="pill rev">مُحرَّر</span> : <span className="pill acct-settled">تخصيص</span>) : <span className="pill rev">تحرير</span>}</td>
                  <td data-label="من → إلى" className="mono">{a.entry.ref} → {a.invoice.invoiceNo}</td>
                  <td data-label="على الفاتورة" className="num">{money(a.amount, a.currency)}</td>
                  <td data-label="من الرصيد" className="num">{money(a.creditAmount, a.creditCurrency)}{a.crossCurrency && <div className="small-note muted">@{num(a.rate)}</div>}</td>
                  <td data-label="المصدر">{{ direct: "مباشر مع الدفعة", manual: "يدوي", auto: "تلقائي", release: "تحرير" }[a.source]}<div className="small-note muted">{a.note}</div></td>
                  <td data-label="بواسطة">{a.createdBy} <span className="muted small-note">{fmtDateTime(a.createdAt)}</span></td>
                  <td className="row-actions">{a.kind === "apply" && !a.released && !a.needsReview && <button className="btn small ghost" onClick={() => setModal({ kind: "release", alloc: a })}>تحرير</button>}</td>
                </tr>
              ))}</tbody></table></div>
          )}
        </section>
      )}

      {/* ------------------------------------------------ كشف الحساب / سجل المعاملات */}
      {tab === "ledger" && (
        <section>
          <p className="hint-box">الرصيد الجاري لكل عملة على حدة: موجب = عليكم للتاجر، سالب = لكم لديه (سلفة). القيود لا تُعدَّل ولا تُحذف: التصحيح بقيد عكسي. القيمة بعملة القيد الأصلية.</p>
          <div className="toolbar">
            <select aria-label="العملة" value={filters.currency} onChange={(e) => setFilter({ currency: e.target.value })}><option value="">العملتان (كل قيد بعملته)</option><option value="SYP">الليرة السورية</option><option value="USD">الدولار الأمريكي</option></select>
            <select aria-label="نوع القيد" value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
              <option value="">كل القيود</option>{Object.entries(ENTRY_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label className="inline-field">من <input type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
            <label className="inline-field">إلى <input type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
            {(filters.type || filters.currency || filters.from || filters.to) && <button className="btn small ghost" onClick={() => setFilters({ type: "", currency: "", from: "", to: "", page: 1 })}>مسح الفلاتر</button>}
          </div>
          <ErrorBanner error={ledger.error} onRetry={ledger.reload} />
          {ledger.data.items.length === 0 ? <EmptyState title="لا توجد قيود" text="ستظهر هنا كل حركة مالية مع هذا التاجر." /> : (
            <>
              <div className="table-wrap" aria-busy={ledger.loading}>
                <table className="table-cards">
                  <thead><tr><th>التاريخ / المرجع</th><th>النوع</th><th>البيان</th><th className="num">مدين (عليكم)</th><th className="num">دائن (لكم)</th><th className="num">الرصيد</th><th /></tr></thead>
                  <tbody>
                    {ledger.data.items.map((e) => (
                      <tr key={e.id} className={e.reversedBy ? "row-reversed" : ""}>
                        <td data-label="التاريخ / المرجع" className="nowrap">{dateOnly(e.date)}<div className="mono small-note muted">{e.ref}</div></td>
                        <td data-label="النوع"><span className={`pill ${e.type === "reversal" || e.reversedBy ? "rev" : e.credit ? "acct-settled" : "acct-due"}`}>{ENTRY_TYPE[e.type]}</span></td>
                        <td data-label="البيان" className="note-cell">
                          {e.note}
                          <div className="small-note muted">
                            {e.invoice?.invoiceNo && <>فاتورة {e.invoice.invoiceNo} · </>}
                            {e.settlement && <>تسوية {e.settlement.ref} · </>}
                            {e.supplierReturn?.ref && <>إرجاع {e.supplierReturn.ref} · </>}
                            {e.movesCash && <>{e.type === "reversal" ? "أُعيد" : "خرج"} نقداً {e.type === "reversal" ? "إلى" : "من"} صندوق {CUR_NAME[e.currency]} · </>}
                            {e.crossCurrency && <>سدّد {money(e.crossCurrency.settles, e.crossCurrency.invoiceCurrency)} بسعر مُدخَل {num(e.crossCurrency.rate)} · </>}
                            {e.valuationUsd != null && <>توثيق: ≈ {money(e.valuationUsd, "USD")} @{num(e.rate)} · </>}
                            {e.reverses && <>يعكس {e.reverses.ref} · </>}
                            {e.reversedBy && <>معكوس بـ {e.reversedBy.ref} · </>}
                            {e.createdBy}
                          </div>
                        </td>
                        <td data-label="مدين" className="num">{e.debit ? money(e.debit, e.currency) : "—"}</td>
                        <td data-label="دائن" className="num">{e.credit ? money(e.credit, e.currency) : "—"}</td>
                        <td data-label="الرصيد" className={`num ${e.balance > 0.004 ? "amount-due" : e.balance < -0.004 ? "amount-adv" : ""}`}>{netText(e.balance, e.currency)}</td>
                        <td className="row-actions">{e.type !== "reversal" && !e.reversedBy && !e.settlement && <button className="btn small ghost" onClick={() => setModal({ kind: "reverse", entry: e })}>عكس</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={ledger.data.page} pages={ledger.data.pages} total={ledger.data.total} onChange={(p) => setFilters((f) => ({ ...f, page: p }))} />
            </>
          )}
        </section>
      )}

      {/* ------------------------------------------------ بضاعة الأمانة */}
      {tab === "consignment" && (
        <section>
          <ErrorBanner error={consignment.error} onRetry={consignment.reload} />
          <p className="hint-box">بضاعة الأمانة ملك التاجر وتبقى في مخزونكم للبيع. لا تُحتسب التزاماً عند الاستلام؛ يُسجَّل مستحقها فقط بتسوية صريحة بعد البيع وبسعر الاتفاق المسجَّل لكل رتل وبعملته. القيمة تقديرية بأسعار الاتفاق (لا بسعر الجملة الحالي) وكل عملة منفصلة، والأرتال بلا سعر لا تُقيَّم.</p>
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" disabled={!c?.summary.pieces} onClick={() => setModal({ kind: "return" })}>إرجاع بضاعة أمانة</button>
            <button className="btn ghost" disabled={!priceRows.length} onClick={() => setModal({ kind: "price" })}>تسجيل/تعديل سعر الاتفاق للمحدد ({priceRows.length})</button>
          </div>
          {consignment.loading && !c ? <Loading /> : !c || c.models.length === 0 ? <EmptyState title="لا توجد بضاعة أمانة" text="عند استلام شحنة من صفحة «استلام شحنة» اختر هذا التاجر وفعّل «بضاعة أمانة» وأدخل سعر الاتفاق." /> : (
            <>
              {c.summary.unpricedPieces > 0 && <div className="banner warn" role="status"><span>{c.summary.unpricedPieces} قطعة أمانة بلا سعر اتفاق مسجّل: لا يمكن تسويتها ولا تقييمها حتى تسجّل السعر المتفق عليه.</span></div>}
              <div className="table-wrap">
                <table className="table-cards">
                  <thead><tr><th>الموديل</th><th className="num">مستلم</th><th className="num">متبقٍ</th><th className="num">محل</th><th className="num">مستودع</th><th className="num">مباع (صافٍ)</th><th className="num">مسوّى</th><th className="num">مُرجَع</th><th className="num">قيمة المتبقي</th></tr></thead>
                  <tbody>
                    {c.models.map((m) => (
                      <tr key={m.modelId}>
                        <td data-label="الموديل"><Link to={`/models/${m.modelNumber}`} className="mono strong">{m.modelNumber}</Link> <span className="muted small-note">{m.name}</span></td>
                        <td data-label="مستلم" className="num">{m.received}</td><td data-label="متبقٍ" className="num"><b>{m.remaining}</b></td>
                        <td data-label="محل" className="num">{m.shop}</td><td data-label="مستودع" className="num">{m.warehouse}</td>
                        <td data-label="مباع" className="num">{m.sold}</td><td data-label="مسوّى" className="num">{m.settled}</td><td data-label="مُرجَع" className="num">{m.returned}</td>
                        <td data-label="القيمة" className="num">{valText(m.value)}{m.unpriced > 0 && <div className="small-note"><span className="pill consign">{m.unpriced} بلا سعر</span></div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="section-title"><h3>الأرتال المتوفرة وأسعار الاتفاق</h3></div>
              <div className="table-wrap">
                <table className="table-cards">
                  <thead><tr><th /><th>الرتل</th><th>الموديل</th><th>الموقع</th><th>المقاسات</th><th className="num">المتبقي</th><th className="num">سعر الاتفاق (للقطعة)</th><th className="num">القيمة</th></tr></thead>
                  <tbody>
                    {c.series.map((s) => (
                      <tr key={s.id}>
                        <td className="row-actions"><input type="checkbox" aria-label={`تحديد ${s.seriesNo}`} checked={!!priceSel[s.id]} onChange={(e) => setPriceSel((p) => ({ ...p, [s.id]: e.target.checked }))} /></td>
                        <td data-label="الرتل" className="mono strong">{s.seriesNo}</td><td data-label="الموديل" className="mono">{s.modelNumber}</td><td data-label="الموقع">{PLACE[s.location]}</td>
                        <td data-label="المقاسات" className="mono" dir="ltr">{s.sizes.map((x) => `${x.size}:${x.qty}`).join(" ")}</td>
                        <td data-label="المتبقي" className="num">{s.remaining}</td>
                        <td data-label="سعر الاتفاق" className="num">{s.price ? <>{priceText(s.price)}{s.priceHistory.length > 1 && <div className="small-note muted">{s.priceHistory.length - 1} تعديل</div>}</> : <span className="pill consign">لم يُسجَّل</span>}</td>
                        <td data-label="القيمة" className="num">{s.value == null ? "—" : money(s.value.amount, s.value.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {/* ------------------------------------------------ تسويات الأمانة */}
      {tab === "settlements" && (
        <section>
          <ErrorBanner error={eligible.error || settlements.error} onRetry={() => { eligible.reload(); settlements.reload(); }} />
          <p className="hint-box">القطع المباعة من بضاعة الأمانة (من حركات بيع الزبائن، بعد طرح الإلغاء والمرتجع السليم) وما سُوِّي منها سابقاً. التسوية وحدها تنشئ التزاماً للتاجر بسعر الاتفاق وبعملته، وتكون بعملة واحدة في كل مرة، ولا تُسوّى القطعة مرتين. التسوية التزام فقط ولا تُخرج نقداً. مرتجع الزبون التالف لا يُطرح تلقائياً: راجعه يدوياً.</p>
          <div className="section-title"><h3>مباع بانتظار التسوية</h3><button className="btn primary" disabled={!pickedLines.length || !sup.active} onClick={() => setModal({ kind: "settle" })}>تسوية المحدد ({pickedLines.reduce((n, l) => n + l.qty, 0)})</button></div>
          {eligible.loading && !eligible.data ? <Loading /> : eligRows.length === 0 ? <EmptyState title="لا توجد كميات مباعة بانتظار التسوية" text="تظهر هنا قطع الأمانة التي بيعت للزبائن ولم تُسوَّ بعد." /> : (
            <div className="table-wrap"><table className="table-cards">
              <thead><tr><th>الرتل</th><th>الموديل</th><th>المقاس</th><th className="num">مباع</th><th className="num">مسوّى</th><th className="num">القابل للتسوية</th><th className="num">سعر الاتفاق</th><th className="num">التسوية الآن</th></tr></thead>
              <tbody>{eligRows.map((r) => {
                const k = `${r.seriesId}|${r.size}`;
                return (
                  <tr key={k}>
                    <td data-label="الرتل" className="mono">{r.seriesNo}</td><td data-label="الموديل"><span className="mono strong">{r.modelNumber}</span></td><td data-label="المقاس"><span className="size-chip">{r.size}</span></td>
                    <td data-label="مباع" className="num">{r.sold}</td><td data-label="مسوّى" className="num">{r.settled}{r.overSettled && <div className="small-note"><span className="pill pay-unpaid">مسوّى أكثر من المباع: راجع</span></div>}</td>
                    <td data-label="القابل للتسوية" className="num"><b>{r.settleable}</b></td>
                    <td data-label="سعر الاتفاق" className="num">{r.price ? priceText(r.price) : <span className="pill consign">لم يُسجَّل</span>}</td>
                    <td data-label="التسوية الآن" className="num">
                      {r.priced && r.settleable > 0 ? <input className="qty-input" type="number" min="0" max={r.settleable} value={picked[k] || ""} placeholder={`0/${r.settleable}`} aria-label={`كمية التسوية ${r.seriesNo} ${r.size}`}
                        onChange={(e) => { const q = Math.max(0, Math.min(r.settleable, Math.floor(Number(e.target.value) || 0))); setPicked((p) => { const n = { ...p }; if (q) n[k] = q; else delete n[k]; return n; }); }} /> : "—"}
                    </td>
                  </tr>
                );
              })}</tbody></table></div>
          )}
          <div className="section-title"><h3>سجل التسويات</h3></div>
          {(settlements.data?.items.length || 0) === 0 ? <p className="muted">لا توجد تسويات بعد.</p> : (
            <div className="table-wrap"><table className="table-cards">
              <thead><tr><th>التسوية</th><th>البنود</th><th className="num">القطع</th><th className="num">القيمة</th><th>الحالة</th><th /></tr></thead>
              <tbody>{settlements.data.items.map((s) => (
                <tr key={s.id} className={s.status === "reversed" ? "row-reversed" : ""}>
                  <td data-label="التسوية"><span className="mono strong">{s.ref}</span><div className="small-note muted">{fmtDateTime(s.createdAt)}</div><div className="small-note muted mono">{s.invoiceNo} · {s.entryRef}</div></td>
                  <td data-label="البنود">{s.items.map((i, n) => <div key={n} className="small-note"><span className="mono">{i.seriesNo}</span> · {i.modelNumber} {i.size} × {i.qty} @ {money(i.unitAmount, i.currency)}</div>)}</td>
                  <td data-label="القطع" className="num">{s.totalQty}</td><td data-label="القيمة" className="num">{money(s.total, s.currency)}</td>
                  <td data-label="الحالة">{s.status === "reversed" ? <><span className="pill rev">معكوسة</span><div className="small-note muted">{s.reversal?.reason}</div></> : <span className="pill acct-settled">مسجّلة</span>}</td>
                  <td className="row-actions">{s.status === "posted" && <button className="btn small ghost" onClick={() => setModal({ kind: "reverseSettlement", settlement: s })}>عكس</button>}</td>
                </tr>
              ))}</tbody></table></div>
          )}
        </section>
      )}

      {/* ------------------------------------------------ الإرجاعات */}
      {tab === "returns" && (
        <section>
          <ErrorBanner error={returns.error} onRetry={returns.reload} />
          <div className="actions" style={{ justifyContent: "flex-start" }}><button className="btn" disabled={!c?.summary.pieces} onClick={() => setModal({ kind: "return" })}>إرجاع بضاعة أمانة</button></div>
          {returns.loading && !returns.data ? <Loading /> : (returns.data?.items.length || 0) === 0 ? <EmptyState title="لا توجد إرجاعات" text="تظهر هنا عمليات إرجاع بضاعة الأمانة إلى التاجر." /> : (
            <div className="table-wrap">
              <table className="table-cards">
                <thead><tr><th>المرجع</th><th>التاريخ</th><th>البنود</th><th className="num">القطع</th><th className="num">قيمة الاتفاق</th><th>السبب</th><th>القيد المالي</th></tr></thead>
                <tbody>
                  {returns.data.items.map((r) => (
                    <tr key={r.id}>
                      <td data-label="المرجع" className="mono strong">{r.ref}</td>
                      <td data-label="التاريخ" className="nowrap">{fmtDateTime(r.createdAt)}</td>
                      <td data-label="البنود">{r.items.map((i, n) => <div key={n} className="small-note"><span className="mono">{i.seriesNo}</span> · {i.modelNumber} {i.size} × {i.qty} ({PLACE[i.location]})</div>)}</td>
                      <td data-label="القطع" className="num">{r.totalQty}</td>
                      <td data-label="قيمة الاتفاق" className="num">{valText(r.value)}{r.unpricedQty > 0 && <div className="small-note muted">+{r.unpricedQty} بلا سعر</div>}</td>
                      <td data-label="السبب">{r.reason}</td>
                      <td data-label="القيد المالي" className="mono">{r.entryRef || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------ النوافذ */}
      {modal?.kind === "edit" && <SupplierFormModal supplier={sup} onClose={close} onDone={done("تم حفظ بيانات التاجر.")} />}
      {modal?.kind === "toggle" && (
        <ConfirmDialog title={sup.active ? "تعطيل التاجر" : "تفعيل التاجر"} danger={sup.active} busy={toggling} confirmLabel={sup.active ? "تعطيل" : "تفعيل"}
          message={sup.active ? "التاجر المعطّل لا تُسجَّل له قيود جديدة، وتبقى كل سجلاته وحساباته محفوظة. يمكن تفعيله لاحقاً." : "سيعود التاجر فعّالاً ويمكن تسجيل قيود جديدة له."}
          onCancel={close} onConfirm={() => act(() => api.patch(`/suppliers/${id}`, { active: !sup.active }), sup.active ? "تم تعطيل التاجر." : "تم تفعيل التاجر.")} />
      )}
      {modal?.kind === "invoice" && <InvoiceModal supplierId={id} onClose={close} onDone={done("تم تسجيل فاتورة التاجر.")} />}
      {["payment", "advance", "credit", "adjustment"].includes(modal?.kind) && <EntryModal mode={modal.kind} supplierId={id} invoices={invoices.data?.items} initialInvoice={modal.invoice} onClose={close} onDone={done(modal.kind === "payment" || modal.kind === "advance" ? "تم تسجيل القيد وخصم المبلغ من صندوق عملته." : "تم تسجيل القيد في حساب التاجر.")} />}
      {modal?.kind === "allocate" && <AllocateModal supplierId={id} credits={credits} invoices={invoices.data?.items} initialCredit={modal.credit} initialInvoice={modal.invoice} onClose={close} onDone={done("تم تخصيص الرصيد على الفاتورة (بلا حركة نقد).")} />}
      {modal?.kind === "autoAllocate" && (
        <ConfirmDialog title="تطبيق تلقائي للسلف" confirmLabel="تطبيق" busy={toggling}
          message="ستُخصَّص الأرصدة الدائنة المتاحة على الفواتير المفتوحة من الأقدم إلى الأحدث وبنفس العملة فقط، وتُسجَّل كل عملية في سجل التخصيص ويمكن تحريرها. لا حركة نقد."
          onCancel={close} onConfirm={() => act(() => api.post(`/suppliers/${id}/allocations/auto`, {}), "تم التطبيق التلقائي وسُجِّل في سجل التخصيص.")} />
      )}
      {modal?.kind === "release" && <ReasonModal title={`تحرير التخصيص ${modal.alloc.ref}`} text={`سيُعاد ${money(modal.alloc.creditAmount, modal.alloc.creditCurrency)} إلى رصيد ${modal.alloc.entry.ref} المتاح ويعود مستحقاً على الفاتورة ${modal.alloc.invoice.invoiceNo}. يبقى التخصيص الأصلي في السجل ولا يتأثر النقد.`} url={`/suppliers/${id}/allocations/${modal.alloc.id}/release`} confirmLabel="تحرير التخصيص" onClose={close} onDone={done("تم تحرير التخصيص.")} />}
      {modal?.kind === "reverse" && <ReasonModal title={`عكس القيد ${modal.entry.ref}`} text={`${ENTRY_TYPE[modal.entry.type]} بقيمة ${money(modal.entry.amount, modal.entry.currency)}. سيُنشأ قيد عكسي ويبقى الأصل في السجل.${modal.entry.movesCash ? ` وسيُعاد المبلغ إلى صندوق ${CUR_NAME[modal.entry.currency]} بحركة نقد عكسية.` : ""} عكس قيد مالي لا يعيد بضاعة إلى المخزون، ويُحرِّر تخصيصاته إن وُجدت.`} url={`/suppliers/${id}/entries/${modal.entry.id}/reverse`} confirmLabel="عكس القيد" onClose={close} onDone={done("تم عكس القيد. القيد الأصلي محفوظ في السجل.")} />}
      {modal?.kind === "price" && <PriceModal supplierId={id} rows={priceRows} onClose={close} onDone={done("تم حفظ سعر الاتفاق في سجل الأسعار.")} />}
      {modal?.kind === "settle" && <SettleModal supplierId={id} lines={pickedLines} onClose={close} onDone={done("تم تسجيل تسوية الأمانة والتزام التاجر.")} />}
      {modal?.kind === "reverseSettlement" && <ReasonModal title={`عكس التسوية ${modal.settlement.ref}`} text={`سيُعكس التزام ${money(modal.settlement.total, modal.settlement.currency)} وتُحرَّر ${modal.settlement.totalQty} قطعة مسوّاة لتعود قابلة للتسوية. يبقى سجل التسوية الأصلي.`} url={`/suppliers/${id}/settlements/${modal.settlement.id}/reverse`} confirmLabel="عكس التسوية" onClose={close} onDone={done("تم عكس التسوية وتحرير الكميات.")} />}
      {modal?.kind === "return" && <ReturnConsignmentModal supplierId={id} invoices={invoices.data?.items} onClose={close} onDone={done("تم إرجاع البضاعة إلى التاجر وخُصمت من المخزون.")} />}
    </div>
  );
}
