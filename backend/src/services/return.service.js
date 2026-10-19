const productRepo = require("../repositories/productModel.repository");
const invoiceRepo = require("../repositories/invoice.repository");
const returnRepo = require("../repositories/return.repository");
const { nextSeq } = require("../repositories/counter.repository");
const settingService = require("./setting.service");
const invoiceService = require("./invoice.service");
const seriesService = require("./series.service");
const availability = require("./availability.service");
const movementService = require("./movement.service");
const cashService = require("./cash.service");
const { round } = require("../utils/money");
const { runAtomic } = require("../utils/unitOfWork");
const { badRequest, notFound, conflict } = require("../utils/errors");

/**
 * إرجاع أو تبديل. المبدأ المحاسبي:
 *  - المرتجع يُعكس بقيمه وقت البيع الأول (سعره وتكلفته وربحه).
 *  - البديل يُباع بقيم اليوم (صرف اليوم وتكلفته الحالية) في فاتورة جديدة.
 *  - فرق قيمة المبلغ المردود بين اليوم ويوم البيع يُسجَّل "فرق صرف" مستقلاً.
 */
async function createReturn({ invoiceId, items, reason = "", mode = "cash", newInvoice }, actor) {
  if (mode === "exchange" && !(newInvoice && newInvoice.items?.length)) {
    throw badRequest("أضف القطع البديلة لإتمام التبديل.", "EXCHANGE_ITEMS_REQUIRED");
  }
  const invoice = await invoiceRepo.findById(invoiceId);
  if (!invoice) throw notFound("الفاتورة غير موجودة.", "INVOICE_NOT_FOUND");
  if (invoice.status !== "completed") throw conflict("لا يمكن الإرجاع على فاتورة ملغاة.", "INVOICE_CANCELLED");

  // لا تحويل صامت بين العملتين: ائتمان المرتجع يُطبَّق على فاتورة بنفس عملة الفاتورة الأصلية فقط
  if (mode === "exchange" && (newInvoice.currency || "USD") !== invoice.currency) {
    throw badRequest("التبديل يتم بعملة الفاتورة الأصلية نفسها. للتحويل بين العملتين استعمل إرجاعاً نقدياً ثم بيعاً جديداً.", "EXCHANGE_CURRENCY_MISMATCH");
  }
  const { usdToSyp: rate } = await settingService.get();
  if (invoice.currency === "SYP" && !(rate > 0)) throw badRequest("حدّد سعر الصرف من الإعدادات أولاً.", "RATE_REQUIRED");
  const dec = invoice.currency === "SYP" ? 0 : 2;

  const seen = new Set();
  const retItems = items.map((r) => {
    const it = invoice.items[r.itemIndex];
    if (!it || seen.has(r.itemIndex)) throw badRequest("بند غير صالح.", "INVALID_ITEM");
    seen.add(r.itemIndex);
    const available = it.qty - (it.returnedQty || 0);
    if (r.qty > available) throw conflict(`الكمية المتاحة للإرجاع من ${it.modelNumber} (${it.size}) هي ${available} فقط.`, "RETURN_EXCEEDS");
    return {
      itemIndex: r.itemIndex, model: it.model, sizeId: it.sizeId,
      modelNumber: it.modelNumber, name: it.name, brand: it.brand, origin: it.origin, type: it.type, cut: it.cut,
      size: it.size, barcode: it.barcode, qty: r.qty, condition: r.condition === "damaged" ? "damaged" : "good",
      unitPrice: it.unitPrice, unitPriceUsd: it.unitPriceUsd, costPrice: it.costPrice,
      allocations: it.allocations,
      legacy: it.legacy ? { color: it.legacy.color, style: it.legacy.style } : undefined,
    };
  });

  const refundAmount = round(retItems.reduce((s, r) => s + r.unitPrice * r.qty, 0), dec);
  const refundUsd = round(retItems.reduce((s, r) => s + r.unitPriceUsd * r.qty, 0), 4);
  const reversedProfitUsd = round(retItems.reduce((s, r) => s + (r.unitPriceUsd - r.costPrice) * r.qty, 0), 4);
  const writeOffUsd = round(retItems.filter((r) => r.condition === "damaged").reduce((s, r) => s + r.costPrice * r.qty, 0), 4);
  const refundUsdToday = invoice.currency === "SYP" ? round(refundAmount / rate, 4) : refundAmount;
  const fxDiffUsd = round(refundUsdToday - refundUsd, 4);

  return runAtomic(async (ctx) => {
    for (const r of retItems) {
      const ok = await invoiceRepo.reserveReturnedQty(invoice._id, r.itemIndex, r.qty, invoice.items[r.itemIndex].qty, ctx);
      if (!ok) throw conflict("تغيّرت كميات الفاتورة. حدّث الصفحة وأعد المحاولة.", "CONFLICT");
      ctx.undo(() => invoiceRepo.releaseReturnedQty(invoice._id, r.itemIndex, r.qty));
    }

    const ret = await returnRepo.create(
      {
        number: await nextSeq("return", ctx), invoice: invoice._id, invoiceNumber: invoice.number, mode, reason,
        items: retItems, currency: invoice.currency, refundAmount, refundUsd, reversedProfitUsd, writeOffUsd,
        rateAtReturn: invoice.currency === "SYP" ? rate : 0, refundUsdToday, fxDiffUsd,
        cashRefund: mode === "cash" ? refundAmount : 0,
      },
      ctx
    );
    ctx.undo(() => returnRepo.deleteById(ret._id));
    await cashService.recordCustomerRefund(ret, actor, ctx); // رد نقدي فعلي فقط (cashRefund > 0)

    let exchange = null;
    if (mode === "exchange") {
      exchange = await invoiceService.buildAndPersist(ctx, {
        items: newInvoice.items, currency: newInvoice.currency, note: `تبديل على الفاتورة #${invoice.number}`,
        credit: { amount: refundAmount, currency: invoice.currency },
        extra: { returnRef: ret._id, exchangeOfInvoice: invoice.number }, actor,
      });
      await returnRepo.setExchange(ret._id, exchange, ctx);
      ret.exchangeInvoice = exchange._id;
      ret.exchangeInvoiceNumber = exchange.number;
    }

    // إعادة القطع السليمة للمحل بعد فاتورة التبديل (حتى لا تُباع القطعة المرتجعة نفسها)
    let notRestocked = 0;
    const rows = [];
    for (const r of retItems) {
      const base = { qty: r.qty, costUsd: r.qty * r.costPrice, ref: `RET-${ret.number}`, reason };
      if (r.condition === "good") {
        const model = await productRepo.findById(r.model, ctx);
        if (!model || !model.sizes.some((x) => x.size === r.size)) { notRestocked++; continue; }
        // تعود القطع إلى أرتالها الأصلية (أو إلى رتل رصيد المحل للفواتير القديمة)
        const back = await seriesService.restore({ model, size: r.size, qty: r.qty, allocations: r.allocations }, ctx);
        const { model: m, size } = await availability.hydratedSize(model, r.size, ctx);
        rows.push(movementService.buildRow({
          ...base, model: m, size, type: "return", delta: r.qty, to: "shop", before: movementService.beforeOf(size, { shopDelta: r.qty }), after: movementService.pair(size),
          allocations: back.map(({ series, seriesNo, qty, location }) => ({ series, seriesNo, qty, location })),
        }));
      } else {
        const m = await productRepo.findById(r.model, ctx);
        const hs = m ? await availability.hydratedSize(m, r.size, ctx) : null;
        if (hs?.size) rows.push(movementService.buildRow({ ...base, model: hs.model, size: hs.size, type: "return_damaged", delta: 0, before: movementService.pair(hs.size), after: movementService.pair(hs.size) }));
      }
    }
    await movementService.record(rows, ctx);
    return { return: ret, invoice: exchange, notRestocked };
  });
}

const list = ({ from, to }) => {
  const filter = from && to ? { createdAt: { $gte: new Date(from), $lt: new Date(to) } } : {};
  return returnRepo.list(filter);
};

module.exports = { createReturn, list };
