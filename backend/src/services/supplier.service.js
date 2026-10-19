const supplierRepo = require("../repositories/supplier.repository");
const entryRepo = require("../repositories/supplierEntry.repository");
const allocationRepo = require("../repositories/supplierAllocation.repository");
const seriesRepo = require("../repositories/series.repository");
const { normalizeText, escapeRegex } = require("../utils/text");
const acct = require("../utils/supplierAccount");
const { validAmount } = require("../utils/money");
const { parsePaging, pageResult } = require("../utils/pagination");
const { badRequest, notFound, conflict } = require("../utils/errors");

const phoneKeyOf = (p = "") => String(p).replace(/\D/g, "");
const ZERO = () => ({ USD: { invoicedMinor: 0, adjustmentsMinor: 0, creditsMinor: 0 }, SYP: { invoicedMinor: 0, adjustmentsMinor: 0, creditsMinor: 0 } });

// المراكز المالية لكل عملة على حدة (لا جمع ولا تحويل بين الدولار والليرة): مستحق إجمالي / سلف متاحة / صافٍ
function accountFrom(bal, alloc) {
  const b = bal || ZERO();
  const a = alloc || { inv: { USD: 0, SYP: 0 }, credit: { USD: 0, SYP: 0 } };
  const positions = {};
  let hasGross = false, hasAdvance = false;
  for (const c of acct.CURS) {
    const gross = b[c].invoicedMinor + b[c].adjustmentsMinor - a.inv[c];
    const advance = b[c].creditsMinor - a.credit[c];
    positions[c] = { grossPayable: acct.major(c, gross), advance: acct.major(c, advance), net: acct.major(c, gross - advance), grossMinor: gross, advanceMinor: advance };
    if (gross > 0) hasGross = true;
    if (advance > 0) hasAdvance = true;
  }
  return { positions, status: acct.statusOf(hasGross, hasAdvance) };
}

async function accountMap(ids) {
  const [bal, alloc] = await Promise.all([entryRepo.balances(ids), allocationRepo.allocatedBySupplier(ids)]);
  const out = new Map();
  for (const id of new Set([...bal.keys(), ...alloc.keys()])) out.set(id, accountFrom(bal.get(id), alloc.get(id)));
  return out;
}

const EMPTY = accountFrom(null, null);
const present = (s, account, cons) => ({
  id: String(s._id),
  name: s.name,
  phone: s.phone || "",
  address: s.address || "",
  notes: s.notes || "",
  active: s.active,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  positions: Object.fromEntries(acct.CURS.map((c) => [c, { grossPayable: (account || EMPTY).positions[c].grossPayable, advance: (account || EMPTY).positions[c].advance, net: (account || EMPTY).positions[c].net }])),
  status: (account || EMPTY).status,
  consignmentPieces: cons?.pieces || 0,
  consignmentUnpricedPieces: cons?.unpricedPieces || 0,
  consignmentValueUsd: cons?.valueUsd || 0,
  consignmentValueSyp: cons?.valueSyp || 0,
});

async function requireSupplier(id, ctx) {
  const s = await supplierRepo.findById(id, ctx);
  if (!s) throw notFound("التاجر غير موجود.", "SUPPLIER_NOT_FOUND");
  return s;
}

async function assertNotDuplicate(nameKey, phoneKey, excludeId, allow) {
  if (allow) return;
  const dup = await supplierRepo.findDuplicate(nameKey, phoneKey, excludeId);
  if (dup) throw conflict(`يوجد تاجر بنفس الاسم ورقم الهاتف مسبقاً: "${dup.name}". إن كان تاجراً مختلفاً أكّد الإنشاء.`, "DUPLICATE_SUPPLIER", { id: String(dup._id) });
}

async function create({ allowDuplicate, ...body }) {
  const nameKey = normalizeText(body.name);
  const phoneKey = phoneKeyOf(body.phone);
  await assertNotDuplicate(nameKey, phoneKey, null, allowDuplicate);
  const doc = await supplierRepo.create({ ...body, nameKey, phoneKey });
  return present(doc);
}

async function update(id, { allowDuplicate, ...patch }) {
  const cur = await requireSupplier(id);
  const next = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (patch.name !== undefined || patch.phone !== undefined) {
    next.nameKey = normalizeText(patch.name ?? cur.name);
    next.phoneKey = phoneKeyOf(patch.phone ?? cur.phone);
    await assertNotDuplicate(next.nameKey, next.phoneKey, cur._id, allowDuplicate);
  }
  const doc = await supplierRepo.update(cur._id, next);
  return detail(String(doc._id));
}

async function detail(id) {
  const s = await requireSupplier(id);
  const [accounts, cons] = await Promise.all([accountMap([id]), seriesRepo.consignmentTotals([id])]);
  return present(s, accounts.get(String(id)), cons.get(String(id)));
}

// سعر بضاعة أمانة متفق عليه بعملته الأصلية { amount, currency, rate? }: يُحفظ كما أُدخل. لا تحويل ولا سعر صرف مُخترَع (rate توثيق اختياري)
function resolvePrice(price) {
  const currency = price.currency || "USD";
  if (!validAmount(currency, price.amount)) throw badRequest(currency === "SYP" ? "سعر الليرة عدد صحيح." : "سعر الدولار بخانتين عشريتين كحد أقصى.", "INVALID_AMOUNT_PRECISION");
  return { amount: price.amount, currency, rate: price.rate || 0 };
}

// قائمة التجار مع المراكز المالية لكل عملة (تُجمع من القيود وسجل التخصيص لحظة الطلب)
async function list(q) {
  const and = [];
  if (q.active === "true" || q.active === undefined) and.push({ active: true });
  else if (q.active === "false") and.push({ active: false });
  if (q.q && q.q.trim()) {
    const raw = q.q.trim();
    const digits = phoneKeyOf(raw);
    const or = [{ nameKey: new RegExp(escapeRegex(normalizeText(raw))) }, { phone: new RegExp(escapeRegex(raw), "i") }, { address: new RegExp(escapeRegex(raw), "i") }];
    if (digits.length >= 3) or.push({ phoneKey: new RegExp(escapeRegex(digits)) });
    and.push({ $or: or });
  }
  if (q.account) {
    const all = await accountMap(null);
    const ids = (pred) => [...all].filter(([, a]) => pred(a)).map(([id]) => entryRepo.oid(id));
    if (q.account === "settled") and.push({ _id: { $nin: ids((a) => a.status !== "settled") } });
    else if (q.account === "due") and.push({ _id: { $in: ids((a) => a.status === "due" || a.status === "mixed") } });
    else if (q.account === "advance") and.push({ _id: { $in: ids((a) => a.status === "advance" || a.status === "mixed") } });
    else and.push({ _id: { $in: ids((a) => a.status === q.account) } });
  }
  const paging = parsePaging(q, 20);
  const { items, total } = await supplierRepo.list(and.length ? { $and: and } : {}, { sort: { name: 1, _id: 1 }, skip: paging.skip, limit: paging.limit });
  const ids = items.map((s) => String(s._id));
  const [accounts, cons] = await Promise.all([accountMap(ids), seriesRepo.consignmentTotals(ids)]);
  return pageResult(items.map((s) => present(s, accounts.get(String(s._id)), cons.get(String(s._id)))), total, paging);
}

// لوحة الحسابات: مجاميع لكل عملة على حدة (دولار وليرة لا يُجمعان أبداً)
async function summary() {
  const [activeCount, accounts, cons] = await Promise.all([supplierRepo.countActive(), accountMap(null), seriesRepo.consignmentTotals(null)]);
  const totals = Object.fromEntries(acct.CURS.map((c) => [c, { grossMinor: 0, advanceMinor: 0 }]));
  for (const a of accounts.values()) for (const c of acct.CURS) {
    if (a.positions[c].grossMinor > 0) totals[c].grossMinor += a.positions[c].grossMinor;
    if (a.positions[c].advanceMinor > 0) totals[c].advanceMinor += a.positions[c].advanceMinor;
  }
  let pieces = 0, unpriced = 0, valueUsd = 0, valueSyp = 0;
  for (const c of cons.values()) { pieces += c.pieces; unpriced += c.unpricedPieces; valueUsd += c.valueUsd; valueSyp += c.valueSyp; }

  const ids = new Set([...[...accounts].filter(([, a]) => a.status === "due" || a.status === "mixed").map(([id]) => id), ...[...cons].filter(([, c]) => c.pieces > 0).map(([id]) => id)]);
  const docs = ids.size ? await supplierRepo.findByIds([...ids].map(entryRepo.oid)) : [];
  const attention = docs
    .map((s) => present(s, accounts.get(String(s._id)), cons.get(String(s._id))))
    .sort((a, b) => (b.positions.USD.grossPayable - a.positions.USD.grossPayable) || (b.positions.SYP.grossPayable - a.positions.SYP.grossPayable) || b.consignmentPieces - a.consignmentPieces)
    .slice(0, 10);

  return {
    activeSuppliers: activeCount,
    totals: Object.fromEntries(acct.CURS.map((c) => [c, { grossPayable: acct.major(c, totals[c].grossMinor), advance: acct.major(c, totals[c].advanceMinor), net: acct.major(c, totals[c].grossMinor - totals[c].advanceMinor) }])),
    consignmentPieces: pieces,
    consignmentUnpricedPieces: unpriced,
    consignmentValueUsd: Math.round(valueUsd * 100) / 100,
    consignmentValueSyp: Math.round(valueSyp),
    attention,
  };
}

module.exports = { create, update, detail, list, summary, requireSupplier, present, accountFrom, accountMap, resolvePrice };
