const productRepo = require("../repositories/productModel.repository");
const invoiceRepo = require("../repositories/invoice.repository");
const { nextSeq } = require("../repositories/counter.repository");
const settingService = require("./setting.service");
const seriesService = require("./series.service");
const availability = require("./availability.service");
const movementService = require("./movement.service");
const cashService = require("./cash.service");
const { round, convert, computeFlag } = require("../utils/money");
const { runAtomic } = require("../utils/unitOfWork");
const { badRequest, notFound, conflict } = require("../utils/errors");

/**
 * يبني الفاتورة ويحفظها داخل وحدة ذرّية قائمة (ctx). يُستدعى من البيع العادي ومن التبديل.
 * credit = { amount, currency } رصيد مرتجع يُخصم (عند التبديل)
 */
async function buildAndPersist(ctx, { items, currency = "USD", note = "", credit = null, extra = {}, actor }) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest("الفاتورة فارغة", "EMPTY_INVOICE");
  const { usdToSyp: rate } = await settingService.get();
  const needsRate = currency === "SYP" || (credit && credit.currency !== currency);
  if (needsRate && !(rate > 0)) throw badRequest("حدّد سعر الصرف من الإعدادات قبل البيع بالليرة السورية", "RATE_REQUIRED");
  const dec = currency === "SYP" ? 0 : 2;
  const toUsd = (p) => (currency === "USD" ? p : p / rate);

  // 1) بنود الفاتورة: نسخة من بيانات الموديل الحالية
  const lines = [];
  const modelDocs = new Map();
  for (const it of items) {
    const model = await productRepo.findById(it.modelId, ctx);
    if (!model || !model.active) throw notFound("إحدى القطع لم تعد متاحة للبيع.", "MODEL_UNAVAILABLE");
    const size = model.sizes.id(it.sizeId);
    if (!size) throw notFound(`المقاس المطلوب لم يعد موجوداً في ${model.modelNumber}.`, "SIZE_NOT_FOUND");

    const unitPriceUsd = toUsd(it.unitPrice);
    lines.push({
      model: model._id, sizeId: size._id, modelNumber: model.modelNumber,
      name: model.name, brand: model.brand, origin: model.origin, type: model.type, cut: model.cut,
      size: size.size, barcode: size.barcode, qty: it.qty,
      costPrice: model.costPrice, sellPrice: model.sellPrice,
      unitPrice: it.unitPrice, unitPriceUsd: round(unitPriceUsd, 4),
      flag: computeFlag(unitPriceUsd, model.costPrice, model.sellPrice, currency, rate),
    });
    modelDocs.set(String(model._id), model);
  }

  // 2) إنقاص مخزون المحل FIFO من الأرتال الأقدم؛ يُحفظ توزيع كل بند لتعود القطع لأرتالها عند الإلغاء/الإرجاع
  const sold = [];
  for (const line of lines) {
    const model = modelDocs.get(String(line.model));
    const taken = await seriesService.consume({ modelNumber: model.modelNumber, modelId: model._id, size: line.size, location: "shop", qty: line.qty }, ctx);
    line.allocations = taken.map(({ series, seriesNo, qty }) => ({ series, seriesNo, qty }));
    sold.push({ line, model, allocations: taken.map(({ series, seriesNo, qty, location }) => ({ series, seriesNo, qty, location })) });
  }

  // 3) الفاتورة وحركات المخزون
  const totalPaid = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const totalUsd = lines.reduce((s, l) => s + l.unitPriceUsd * l.qty, 0);
  const costUsd = lines.reduce((s, l) => s + l.costPrice * l.qty, 0);
  const creditApplied = credit ? round(convert(credit.amount, credit.currency, currency, rate), dec) : 0;

  const invoice = await invoiceRepo.create(
    {
      number: await nextSeq("invoice", ctx), currency, rate: currency === "SYP" ? rate : 0,
      items: lines, itemsCount: lines.reduce((s, l) => s + l.qty, 0),
      totalPaid: round(totalPaid, dec), creditApplied, cashDue: round(totalPaid - creditApplied, dec),
      totalUsd: round(totalUsd, 4), costUsd: round(costUsd, 4), profitUsd: round(totalUsd - costUsd, 4),
      note, ...extra,
    },
    ctx
  );
  ctx.undo(() => invoiceRepo.deleteById(invoice._id));

  const rows = [];
  for (const { line, model, allocations } of sold) {
    const { model: m, size } = await availability.hydratedSize(model, line.size, ctx);
    rows.push(movementService.buildRow({
      model: m, size, type: "sale", qty: line.qty, delta: -line.qty, from: "shop",
      before: movementService.beforeOf(size, { shopDelta: -line.qty }), after: movementService.pair(size), costUsd: line.qty * m.costPrice, ref: `INV-${invoice.number}`, allocations,
    }));
  }
  await movementService.record(rows, ctx);
  // النقد: المبلغ المدفوع فعلاً بعملة الفاتورة يدخل صندوق تلك العملة فقط (الائتمان المطبَّق ليس نقداً)
  await cashService.recordSale(invoice, actor, ctx);
  return invoice;
}

const createInvoice = (input, actor) => runAtomic((ctx) => buildAndPersist(ctx, { ...input, actor }));

const list = ({ from, to }) => {
  const filter = from && to ? { createdAt: { $gte: new Date(from), $lt: new Date(to) } } : {};
  return invoiceRepo.list(filter);
};

async function getInvoice(id) {
  const inv = await invoiceRepo.findById(id);
  if (!inv) throw notFound("الفاتورة غير موجودة.", "INVOICE_NOT_FOUND");
  return inv;
}

// إلغاء فاتورة: تعود القطع للمحل ولا يُحذف السجل
async function cancelInvoice(id, actor) {
  const invoice = await getInvoice(id);
  if (invoice.status === "cancelled") throw conflict("الفاتورة ملغاة مسبقاً.", "ALREADY_CANCELLED");
  if (invoice.returnRef) throw conflict("هذه فاتورة تبديل ولا تُلغى. استخدم الإرجاع على بنودها.", "EXCHANGE_NOT_CANCELLABLE");
  if (invoice.items.some((i) => i.returnedQty > 0)) throw conflict("لا يمكن إلغاء فاتورة لها مرتجعات.", "HAS_RETURNS");

  return runAtomic(async (ctx) => {
    const marked = await invoiceRepo.markCancelled(invoice._id, ctx);
    if (marked.modifiedCount !== 1) throw conflict("تغيّرت حالة الفاتورة. أعد المحاولة.", "CONFLICT");
    ctx.undo(() => invoiceRepo.unmarkCancelled(invoice._id));

    let notRestocked = 0;
    const rows = [];
    for (const it of invoice.items) {
      const model = await productRepo.findById(it.model, ctx);
      if (!model || !model.sizes.some((s) => s.size === it.size)) { notRestocked++; continue; } // الموديل حُذف أو أُزيل المقاس بعد البيع
      const back = await seriesService.restore({ model, size: it.size, qty: it.qty, allocations: it.allocations }, ctx);
      const { model: m, size } = await availability.hydratedSize(model, it.size, ctx);
      rows.push(movementService.buildRow({
        model: m, size, type: "cancel", qty: it.qty, delta: it.qty, to: "shop",
        before: movementService.beforeOf(size, { shopDelta: it.qty }), after: movementService.pair(size), costUsd: it.qty * it.costPrice,
        ref: `INV-${invoice.number}`, reason: "إلغاء فاتورة",
        allocations: back.map(({ series, seriesNo, qty, location }) => ({ series, seriesNo, qty, location })),
      }));
    }
    await movementService.record(rows, ctx);
    await cashService.recordInvoiceCancel(invoice, actor, ctx); // حركة نقد عكسية بنفس العملة (إن وُجدت حركة قبض)
    return { invoice: await invoiceRepo.findById(invoice._id, ctx), notRestocked };
  });
}

module.exports = { buildAndPersist, createInvoice, list, getInvoice, cancelInvoice };
