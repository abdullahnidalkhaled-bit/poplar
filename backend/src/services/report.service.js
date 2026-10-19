const invoiceRepo = require("../repositories/invoice.repository");
const returnRepo = require("../repositories/return.repository");
const movementRepo = require("../repositories/movement.repository");
const availability = require("./availability.service");
const { badRequest } = require("../utils/errors");

// ------------------------------------------------------------------ Dashboard المخزون
// التوفر والتنبيهات من availability.service (المصدر الوحيد)؛ هنا فقط تجميع العرض
async function dashboard() {
  const { totals, attention } = await availability.inventoryOverview();
  const recent = await movementRepo.recent(8);
  return {
    totals,
    counts: {
      restock: attention.reduce((n, m) => n + m.restockSizes.length, 0),
      transfer: attention.reduce((n, m) => n + m.transferSizes.length, 0),
    },
    attention,
    recent,
  };
}

// ------------------------------------------------------------------ مخزون حالي (صفحة التقارير)
async function inventoryReport() {
  const d = await dashboard();
  return {
    totals: {
      pieces: d.totals.combined, shopPieces: d.totals.shop, warehousePieces: d.totals.warehouse,
      costValueUsd: d.totals.costValueUsd, sellValueUsd: d.totals.sellValueUsd,
    },
    attention: d.attention,
  };
}

// ------------------------------------------------------------------ ملخص المبيعات (يوم/شهر) الصافي
const ZERO_RET = { count: 0, pieces: 0, refundUsd: 0, reversedProfitUsd: 0, fxDiffUsd: 0, writeOffUsd: 0 };

const netRows = (sales, returns) => {
  const map = new Map(sales.map((r) => [JSON.stringify(r._id), { ...r }]));
  for (const r of returns) {
    const k = JSON.stringify(r._id);
    const row = map.get(k) || { _id: r._id, pieces: 0, revenueUsd: 0, costUsd: 0 };
    row.pieces -= r.pieces;
    row.revenueUsd -= r.revenueUsd;
    row.costUsd -= r.costUsd;
    map.set(k, row);
  }
  return [...map.values()].map((r) => ({ ...r, profitUsd: r.revenueUsd - r.costUsd })).sort((a, b) => b.revenueUsd - a.revenueUsd);
};

async function summary({ from, to, tz }) {
  if (!from || !to) throw badRequest("حدّد الفترة (from و to).", "RANGE_REQUIRED");
  const zone = /^[A-Za-z0-9_+\-/]+$/.test(tz || "") ? tz : "UTC";
  const range = { $gte: new Date(from), $lt: new Date(to) };
  const day = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: zone } };

  const [r, ret, damagedRow] = await Promise.all([
    invoiceRepo.salesSummary(range, day),
    returnRepo.returnsSummary(range, day),
    movementRepo.damagedTotals(range),
  ]);
  const damaged = damagedRow ? [damagedRow] : [];

  const g = r.totals[0] || { invoices: 0, pieces: 0, revenueUsd: 0, costUsd: 0, profitUsd: 0 };
  const R = ret.totals[0] || ZERO_RET;
  const D = damaged[0] || { pieces: 0, costUsd: 0 };

  // الصافي = المبيعات - عكس المرتجعات - فرق الصرف - تالف المرتجعات - التالف المباشر
  const net = {
    revenueUsd: g.revenueUsd - R.refundUsd,
    costUsd: g.costUsd - (R.refundUsd - R.reversedProfitUsd),
    profitUsd: g.profitUsd - R.reversedProfitUsd - R.fxDiffUsd - R.writeOffUsd - D.costUsd,
    pieces: g.pieces - R.pieces,
  };

  const cashOut = Object.fromEntries(ret.cash.map((c) => [c._id, c.total]));
  const currencies = new Set([...r.collected.map((c) => c._id), ...Object.keys(cashOut)]);
  const collected = [...currencies].map((cur) => {
    const row = r.collected.find((c) => c._id === cur);
    return { _id: cur, total: (row?.total || 0) - (cashOut[cur] || 0), refunded: cashOut[cur] || 0, invoices: row?.invoices || 0 };
  });

  const dayMap = new Map(r.daily.map((d) => [d._id, { ...d }]));
  for (const d of ret.daily) {
    const row = dayMap.get(d._id) || { _id: d._id, invoices: 0, revenueUsd: 0, profitUsd: 0 };
    row.revenueUsd -= d.revenueUsd;
    row.profitUsd -= d.profitUsd;
    dayMap.set(d._id, row);
  }

  return {
    totals: g, net, returns: R, damaged: D, collected,
    daily: [...dayMap.values()].sort((a, b) => (a._id < b._id ? -1 : 1)),
    byBrand: netRows(r.byBrand, ret.byBrand),
    byOrigin: netRows(r.byOrigin, ret.byOrigin),
    top: r.top, flags: r.flags, belowCost: r.belowCost,
  };
}

module.exports = { dashboard, inventoryReport, summary };
