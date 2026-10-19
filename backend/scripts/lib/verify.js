/*
 * فحص سلامة البيانات المالية والمخزنية (يُستعمل من السيد seed ومن الاختبارات): يعيد { ok, problems[], summary }.
 * الأرصدة النقدية تُعاد اشتقاقها مستقلةً من المعاملات المصدرية، ثم تُقارَن بدفتر cash_movements (لا نثق بالدفتر لإثبات نفسه).
 * لا يكتب شيئاً.
 */
const { toMinorC, fromMinorC } = require("../../src/utils/money");
const acct = require("../../src/utils/supplierAccount");
const payrollMath = require("../../src/utils/payroll");

async function verifyIntegrity(db) {
  const col = (n) => db.collection(n);
  const all = async (n, q = {}) => col(n).find(q).toArray();
  const problems = [];
  const bad = (m) => problems.push(m);

  const [invoices, returns, entries, expenses, cash, supInvoices, allocs, settlements, series, suppliers, movements, advances, payLedger, periods] = await Promise.all(
    ["invoices", "returns", "supplier_entries", "expenses", "cash_movements", "supplier_invoices", "supplier_allocations", "supplier_settlements", "series", "suppliers", "stockmovements", "employee_advances", "employee_ledger", "payroll_periods"].map((n) => all(n))
  );
  const byId = (arr) => new Map(arr.map((x) => [String(x._id), x]));
  const inv = byId(invoices), ret = byId(returns), ent = byId(entries), exp = byId(expenses), cm = byId(cash), sup = byId(suppliers), si = byId(supInvoices), ser = byId(series);

  // ---------- 1) كل حركة نقد: مصدر موجود، نفس العملة، نفس المبلغ، اتجاه منطقي، عملة واحدة صحيحة
  const sources = { invoice: inv, return: ret, supplier_entry: ent, expense: exp, employee_advance: byId(advances), payroll_payment: byId(payLedger) };
  for (const m of cash) {
    if (!["USD", "SYP"].includes(m.currency)) bad(`${m.ref}: عملة غير صالحة`);
    if (!Number.isInteger(m.amountMinor) || m.amountMinor < 1) bad(`${m.ref}: مبلغ غير صحيح`);
    if (m.source.kind === "manual") continue;
    const src = sources[m.source.kind]?.get(String(m.source.id));
    if (!src) { bad(`${m.ref}: مصدر ${m.source.kind} غير موجود`); continue; }
    if (src.currency !== m.currency) bad(`${m.ref}: عملة الحركة ${m.currency} تخالف عملة مصدرها ${src.currency}`);
    if (m.reverses) {
      const o = cm.get(String(m.reverses));
      if (!o || o.currency !== m.currency || o.amountMinor !== m.amountMinor || o.direction === m.direction) bad(`${m.ref}: عكس غير مطابق للأصل`);
      continue;
    }
    const expected =
      m.source.kind === "invoice" ? Math.abs(toMinorC(src.currency, src.cashDue ?? src.totalPaid))
      : m.source.kind === "return" ? toMinorC(src.currency, src.cashRefund || 0)
      : m.source.kind === "supplier_entry" ? acct.amountMinorOf(src)
      : src.amountMinor;
    if (m.amountMinor !== expected) bad(`${m.ref}: مبلغ ${m.amountMinor} يخالف مبلغ المصدر ${expected}`);
    if (m.source.kind === "supplier_entry" && !acct.CASH_OUT_TYPES.has(src.type)) bad(`${m.ref}: قيد مورّد من نوع ${src.type} لا يجوز أن ينشئ حركة نقد`);
  }

  // ---------- 2) إعادة اشتقاق الرصيد لكل عملة من المصادر (مستقلة عن الدفتر) ثم مقارنتها بالدفتر
  const expected = { USD: 0, SYP: 0 };
  for (const i of invoices) {
    if (i.status === "completed") { const due = toMinorC(i.currency, i.cashDue ?? i.totalPaid); expected[i.currency] += due; }
  }
  for (const r of returns) expected[r.currency] -= toMinorC(r.currency, r.cashRefund || 0);
  for (const e of entries) if (acct.CASH_OUT_TYPES.has(e.type) && !e.reversedBy) expected[e.currency] -= acct.amountMinorOf(e);
  for (const x of expenses) if (x.status === "posted" && x.method !== "other") expected[x.currency] -= x.amountMinor; // دفع الراتب من خارج الصندوق لا يخرج نقداً
  // الرواتب والسلف: النقد يخرج فقط للسلف المصروفة نقداً (غير المعكوسة) ولدفعات الراتب النقدية غير المعكوسة
  for (const a of advances) if (a.disbursement?.method === "cash" && ["disbursed", "partially_settled", "settled"].includes(a.status)) expected[a.currency] -= a.amountMinor;
  for (const l of payLedger) if (l.type === "salary_payment" && l.cash && !l.expense && !l.reversedBy) expected[l.currency] -= l.amountMinor; // الدفعات عبر المصروفات تُحتسب ضمن المصروفات أعلاه
  // عدّادات كل فترة راتب = مجموع قيود دفترها غير المعكوسة، والمتبقي لا يقل عن صفر
  for (const p of periods) {
    const c = payrollMath.countersFromLedger(payLedger.filter((l) => String(l.period) === String(p._id)));
    for (const f of Object.keys(c)) if ((p[f] || 0) !== c[f]) bad(`${p.ref}: عدّاد ${f} (${p[f] || 0}) يخالف دفتر الموظف (${c[f]})`);
    if (payrollMath.remainingPayable(p) < 0) bad(`${p.ref}: المتبقي سالب`);
  }
  // روابط مصروفات الرواتب: كل مصروف بموظف له قيد دفعة بالمبلغ نفسه، وكل قيد دفعة مرتبط بمصروف موجود بالمبلغ نفسه (يكشف بقايا انقطاع العملية في الوضع غير المعاملاتي)
  const ledById = new Map(payLedger.map((l) => [String(l._id), l]));
  const expById = new Map(expenses.map((x) => [String(x._id), x]));
  for (const x of expenses) {
    if (!x.employee) continue;
    const l = x.payrollEntry ? ledById.get(String(x.payrollEntry)) : null;
    if (!l) bad(`${x.ref}: مصروف راتب بلا قيد دفعة في دفتر الموظف`);
    else if (l.amountMinor !== x.amountMinor || String(l.expense) !== String(x._id)) bad(`${x.ref}: قيد الدفعة ${l.ref} لا يطابق المصروف (مبلغ/ربط)`);
    if (x.method !== "other" && x.status === "posted" && !x.cash) bad(`${x.ref}: مصروف راتب نقدي بلا حركة نقد`);
  }
  for (const l of payLedger) {
    if (l.type !== "salary_payment" || !l.expense) continue;
    const x = expById.get(String(l.expense));
    if (!x) bad(`${l.ref}: قيد دفعة مرتبط بمصروف غير موجود`);
    else if (x.amountMinor !== l.amountMinor) bad(`${l.ref}: مبلغ القيد يخالف مبلغ المصروف ${x.ref}`);
  }
  for (const a of advances) if ((a.settledMinor || 0) !== payLedger.filter((l) => String(l.advance) === String(a._id) && l.type === "advance_settlement" && !l.reversedBy).reduce((n, l) => n + l.amountMinor, 0)) bad(`${a.ref}: المُسوَّى يخالف الدفتر`);
  const ledger = { USD: 0, SYP: 0 };
  let manualNet = { USD: 0, SYP: 0 };
  for (const m of cash) {
    const signed = (m.direction === "in" ? 1 : -1) * m.amountMinor;
    ledger[m.currency] += signed;
    if (m.source.kind === "manual") manualNet[m.currency] += signed;
  }
  for (const c of ["USD", "SYP"]) {
    if (ledger[c] !== expected[c] + manualNet[c]) bad(`صندوق ${c}: الدفتر ${ledger[c]} ≠ المشتق من المصادر ${expected[c] + manualNet[c]} (يدوي ${manualNet[c]})`);
  }
  // لا حركة مزدوجة لنفس المصدر والاتجاه (غير العكسية)
  const seen = new Map();
  for (const m of cash.filter((x) => !x.reverses && m_kind(x))) {
    const k = `${m.source.kind}:${m.source.id}:${m.direction}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) bad(`حركة نقد مكررة للمصدر ${k} (${n})`);
  function m_kind(x) { return x.source.kind !== "manual"; }

  // ---------- 3) التجار: فواتير/قيود/تخصيصات/تسويات متسقة العملة والمراجع، بلا تجاوز
  for (const e of entries) {
    if (!sup.has(String(e.supplier))) bad(`${e.ref}: تاجر غير موجود`);
    if (e.invoice && !si.has(String(e.invoice))) bad(`${e.ref}: فاتورة تاجر غير موجودة`);
    if (e.invoice && si.get(String(e.invoice)) && si.get(String(e.invoice)).currency !== e.currency && !e.crossCurrency && ["payment", "credit", "return_credit"].includes(e.type) && !e.reverses) bad(`${e.ref}: ربط بفاتورة بعملة مختلفة دون تأكيد صريح`);
  }
  const perEntry = new Map(), perInvoice = new Map();
  for (const a of allocs.filter(acct.isLiveAlloc)) {
    const e = ent.get(String(a.entry)), i = si.get(String(a.invoice));
    if (!e || !i) { bad(`${a.ref}: مرجع مفقود`); continue; }
    if (a.currency !== i.currency || a.creditCurrency !== e.currency) bad(`${a.ref}: عملات التخصيص لا تطابق الفاتورة/القيد`);
    if (a.currency === a.creditCurrency && a.amountMinor !== a.creditMinor) bad(`${a.ref}: تخصيص بعملة واحدة بمبلغين مختلفين`);
    if (a.currency !== a.creditCurrency && !(a.crossCurrency && a.rate > 0)) bad(`${a.ref}: تخصيص عبر عملتين بلا تأكيد وسعر صرف صريح`);
    perEntry.set(String(a.entry), (perEntry.get(String(a.entry)) || 0) + a.creditMinor);
    perInvoice.set(String(a.invoice), (perInvoice.get(String(a.invoice)) || 0) + a.amountMinor);
  }
  for (const [id, v] of perEntry) if (v > acct.amountMinorOf(ent.get(id))) bad(`قيد ${ent.get(id).ref}: تخصيصات تتجاوز مبلغه`);
  for (const [id, v] of perInvoice) if (v > acct.invoiceMinorOf(si.get(id))) bad(`فاتورة ${si.get(id).invoiceNo}: تخصيصات تتجاوز قيمتها`);

  // ---------- 4) الأمانة: لا تسوية فوق المباع، ولا بند بلا سعر، وتطابق settledQty مع التسويات السارية
  const sold = new Map();
  for (const mv of movements.filter((x) => ["sale", "cancel", "return"].includes(x.type))) {
    for (const a of mv.allocations || []) {
      const k = `${a.series}|${mv.size}`;
      sold.set(k, (sold.get(k) || 0) + (mv.type === "sale" ? a.qty : -a.qty));
    }
  }
  const settledBy = new Map();
  for (const s of settlements.filter((x) => x.status === "posted")) {
    for (const it of s.items) { const k = `${it.series}|${it.size}`; settledBy.set(k, (settledBy.get(k) || 0) + it.qty); }
    if (new Set(s.items.map((i) => i.currency)).size > 1) bad(`${s.ref}: تسوية بعملتين`);
    const inv2 = si.get(String(s.invoice));
    if (!inv2 || inv2.currency !== s.currency) bad(`${s.ref}: فاتورة التسوية مفقودة أو بعملة مختلفة`);
  }
  for (const s of series.filter((x) => x.ownership === "consignment")) {
    if (!sup.has(String(s.supplier))) bad(`${s.seriesNo}: تاجر الأمانة مفقود`);
    for (const z of s.sizes) {
      const k = `${s._id}|${z.size}`;
      if ((z.settledQty || 0) !== (settledBy.get(k) || 0)) bad(`${s.seriesNo}/${z.size}: settledQty ${z.settledQty || 0} ≠ التسويات السارية ${settledBy.get(k) || 0}`);
      if ((z.settledQty || 0) > (sold.get(k) || 0)) bad(`${s.seriesNo}/${z.size}: مسوّى أكثر من المباع`);
      if ((z.settledQty || 0) > 0 && !(s.consignment?.price?.amount > 0)) bad(`${s.seriesNo}: تسوية بلا سعر اتفاق`);
    }
  }
  for (const s of series.filter((x) => x.ownership !== "consignment" && x.supplier && x.ownership === "consignment")) bad(`${s.seriesNo}: ملكية متناقضة`);

  // ---------- 5) المخزون والمراجع
  for (const s of series) {
    for (const z of s.sizes) if (z.qty < 0) bad(`${s.seriesNo}/${z.size}: كمية سالبة`);
    if (s.kind === "received") for (const z of s.sizes) if (z.initialQty > 2) bad(`${s.seriesNo}/${z.size}: أكثر من قطعتين في رتل مستلم`);
  }
  for (const mv of movements) for (const a of mv.allocations || []) if (!ser.has(String(a.series))) bad(`حركة ${mv.ref || mv._id}: رتل مرجعي مفقود`);
  for (const r of await all("supplier_returns")) for (const it of r.items) if (!ser.has(String(it.series))) bad(`${r.ref}: رتل مفقود`);

  const out = {};
  for (const c of ["USD", "SYP"]) out[c] = { balanceMinor: ledger[c], balance: fromMinorC(c, ledger[c]), openingMinor: manualNet[c], derivedFromSourcesMinor: expected[c] };
  return { ok: problems.length === 0, problems, summary: out };
}

module.exports = { verifyIntegrity };
