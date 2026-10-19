const productRepo = require("../repositories/productModel.repository");
const shipmentRepo = require("../repositories/shipment.repository");
const seriesRepo = require("../repositories/series.repository");
const { nextSeq } = require("../repositories/counter.repository");
const productModelService = require("./productModel.service");
const supplierService = require("./supplier.service");
const ledger = require("./supplierLedger.service");
const invoiceRepo = require("../repositories/supplierInvoice.repository");
const seriesService = require("./series.service");
const availability = require("./availability.service");
const movementService = require("./movement.service");
const { normalizeModelNumber } = require("../utils/modelNumber");
const { validateSeriesComposition } = require("../utils/series");
const { normalizeSize } = require("../utils/sizes");
const { round } = require("../utils/money");
const { runAtomic } = require("../utils/unitOfWork");
const { notFound, conflict, badRequest } = require("../utils/errors");

const qk = (loc) => (loc === "shop" ? "shopQty" : "warehouseQty");
const dk = (loc) => (loc === "shop" ? "shopDelta" : "warehouseDelta");
const strip = ({ series, seriesNo, qty, location }) => ({ series, seriesNo, qty, location });

// دمج بنود المقاس المكرر في الطلب
function mergeItems(items) {
  const map = new Map();
  for (const i of items) {
    const size = normalizeSize(i.size);
    map.set(size, (map.get(size) || 0) + i.qty);
  }
  return [...map].map(([size, qty]) => ({ size, qty }));
}

async function activeModel(modelNumber, ctx) {
  const doc = await productModelService.requireModel(modelNumber, ctx);
  if (!doc.active) throw conflict("هذا الموديل مؤرشف.", "MODEL_ARCHIVED");
  return doc;
}

function requireSize(model, size) {
  if (!model.sizes.some((s) => s.size === size)) throw notFound(`المقاس ${size} غير موجود في الموديل ${model.modelNumber}.`, "SIZE_NOT_FOUND");
}

const result = async (doc, extra = {}) => ({ model: await availability.hydrate(doc), ...extra });

// ---------------------------------------------------------------- استلام شحنة (رتل واحد أو أكثر)
async function receiveShipment(input, actor) {
  const { location, unitCostUsd, note = "", idempotencyKey } = input;
  const modelNumber = normalizeModelNumber(input.modelNumber);
  const seriesInput = input.series.map((s) => ({ sizes: s.sizes.map((x) => ({ size: normalizeSize(x.size), qty: x.qty })) }));
  seriesInput.forEach((s, i) => {
    const errors = validateSeriesComposition(s.sizes);
    if (errors.length) throw badRequest(`الرتل ${i + 1}: ${errors[0]}`, "INVALID_SERIES", errors);
  });
  const model0 = await activeModel(modelNumber);

  // ملكية الشحنة: تاجر (اختياري) + بضاعة أمانة. الأمانة بلا تاجر مرفوضة، ولا ينشأ التزام مالي هنا أبداً
  let supplierId;
  if (input.supplierId) {
    const supplier = await supplierService.requireSupplier(input.supplierId);
    if (!supplier.active) throw conflict("التاجر معطّل.", "SUPPLIER_INACTIVE");
    supplierId = supplier._id;
  }
  if (input.consignment && !supplierId) throw badRequest("بضاعة الأمانة تتطلب تحديد التاجر المالك.", "SUPPLIER_REQUIRED");
  const ownership = input.consignment ? "consignment" : "owned";
  if (input.consignmentPrice && !input.consignment) throw badRequest("سعر الاتفاق خاص ببضاعة الأمانة.", "PRICE_NOT_CONSIGNMENT");
  if (input.purchase && (!supplierId || input.consignment)) throw badRequest("فاتورة الشراء تتطلب تاجراً وشراءً عادياً (لا أمانة).", "PURCHASE_REQUIRES_OWNED_SUPPLIER");
  const consignmentPrice = input.consignmentPrice ? await supplierService.resolvePrice(input.consignmentPrice) : undefined;

  // مطالبة بمفتاح الشحنة الفريد: نفس الطلب مرتين لا يُنفَّذ إلا مرة واحدة
  let shipment;
  try {
    shipment = await shipmentRepo.create({ idempotencyKey, modelNumber, location, series: seriesInput, unitCostUsd, note, ...(supplierId ? { supplier: supplierId, ownership } : {}), ...(consignmentPrice ? { consignmentPrice } : {}) });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const prior = await shipmentRepo.findByKey(idempotencyKey);
    if (prior && prior.modelNumber !== modelNumber) throw conflict("مفتاح الطلب مستخدم لشحنة أخرى.", "IDEMPOTENCY_MISMATCH");
    if (prior?.status === "applied") {
      const created = await seriesRepo.findManyByIds(prior.seriesIds);
      const inv = prior.invoice ? await invoiceRepo.findById(prior.invoice) : null;
      return result(await productRepo.findById(model0._id), { duplicate: true, series: created.map(seriesService.present), ...(inv ? { purchase: { invoice: { id: String(inv._id), invoiceNo: inv.invoiceNo, currency: inv.currency, amount: inv.amount }, duplicate: true } } : {}) });
    }
    throw conflict("هذه الشحنة قيد المعالجة. لا تُعد الإرسال.", "SHIPMENT_IN_PROGRESS");
  }

  try {
    const out = await runAtomic(async (ctx) => {
      const current = await productRepo.findById(model0._id, ctx);

      // مقاسات جديدة تُضاف للموديل تلقائياً (بباركود داخلي)
      const wanted = [...new Set(seriesInput.flatMap((s) => s.sizes.map((x) => x.size)))];
      const known = new Set(current.sizes.map((s) => s.size));
      const fresh = wanted.filter((s) => !known.has(s));
      if (fresh.length) {
        const docs = [];
        for (const size of fresh) docs.push({ size, barcode: `POP-${String(await nextSeq("barcode", ctx)).padStart(6, "0")}` });
        const withSizes = await productRepo.addSizes(current._id, docs, ctx);
        if (!withSizes) throw conflict("تغيّرت مقاسات الموديل أثناء العملية. أعد المحاولة.", "CONFLICT");
        const ids = withSizes.sizes.filter((s) => fresh.includes(s.size)).map((s) => s._id);
        ctx.undo(() => productRepo.removeSizes(current._id, ids));
      }

      const totalQty = seriesInput.reduce((n, s) => n + s.sizes.reduce((m, x) => m + x.qty, 0), 0);

      // المتوسط المرجّح للتكلفة مع تحكم تفاؤلي (rev) ليكون الحساب صحيحاً حتى تحت التزامن
      let usedCost = current.costPrice;
      if (unitCostUsd !== undefined) {
        usedCost = unitCostUsd;
        let applied = false;
        for (let attempt = 0; attempt < 5 && !applied; attempt++) {
          const cur = await productRepo.findById(current._id, ctx);
          const before = await availability.modelTotal(cur._id, ctx);
          const newCost = before > 0 ? round((before * cur.costPrice + totalQty * unitCostUsd) / (before + totalQty), 4) : unitCostUsd;
          const upd = await productRepo.setCostIfUnchanged(cur._id, cur.rev, newCost, ctx);
          if (upd) {
            applied = true;
            ctx.undo(() => productRepo.forceCost(cur._id, cur.costPrice));
          }
        }
        if (!applied) throw conflict("تعارض أثناء الحفظ بسبب تعديل متزامن. أعد المحاولة.", "CONFLICT");
      }

      const ref = `SHP-${String(shipment._id).slice(-6).toUpperCase()}`;
      const modelForSnapshot = await productRepo.findById(current._id, ctx);
      const created = [];
      for (const s of seriesInput) {
        created.push(await seriesService.createReceived(modelForSnapshot, { location, sizes: s.sizes, shipmentRef: ref, note, supplier: supplierId, ownership, consignmentPrice }, ctx));
      }

      // حركة استلام لكل (رتل، مقاس) مع قبل/بعد متسلسلين
      const hydrated = await availability.hydrate(modelForSnapshot, ctx);
      const totalBySize = new Map();
      for (const s of seriesInput) for (const x of s.sizes) totalBySize.set(x.size, (totalBySize.get(x.size) || 0) + x.qty);
      const running = new Map();
      const rows = [];
      created.forEach((doc, i) => {
        for (const x of seriesInput[i].sizes) {
          const sz = hydrated.sizes.find((s) => s.size === x.size);
          const endQty = sz[qk(location)];
          const startQty = endQty - totalBySize.get(x.size) + (running.get(x.size) || 0);
          running.set(x.size, (running.get(x.size) || 0) + x.qty);
          const before = location === "shop" ? { shop: startQty, warehouse: sz.warehouseQty } : { shop: sz.shopQty, warehouse: startQty };
          const after = location === "shop" ? { shop: startQty + x.qty, warehouse: sz.warehouseQty } : { shop: sz.shopQty, warehouse: startQty + x.qty };
          rows.push(movementService.buildRow({
            model: hydrated, size: sz, type: "receive", qty: x.qty, delta: x.qty, to: location, before, after,
            costUsd: x.qty * usedCost, reason: note || (ownership === "consignment" ? "استلام بضاعة أمانة" : "استلام شحنة"), ref, batchId: String(shipment._id),
            allocations: [{ series: doc._id, seriesNo: doc.seriesNo, qty: x.qty, location }],
          }));
        }
      });
      await movementService.record(rows, ctx);
      // شراء عادي: الفاتورة (والدفع/السلف إن وُجدت) في نفس الوحدة الذرّية: فشل أي جزء يُلغي الاستلام كله
      let purchase;
      if (input.purchase) {
        const supplier = await supplierService.requireSupplier(supplierId, ctx);
        purchase = await ledger.postReceiptPurchase(supplier, input.purchase, { shipmentRef: ref, seriesNos: created.map((s) => s.seriesNo), key: idempotencyKey, actor }, ctx);
      }
      return { doc: modelForSnapshot, created, purchase };
    });
    await shipmentRepo.markApplied(shipment._id, out.created.map((s) => s._id), out.purchase?.invoice._id);
    return result(out.doc, { duplicate: false, series: out.created.map(seriesService.present), ...(out.purchase ? { purchase: { ...ledger.presentReceiptPurchase(out.purchase), shipmentRef: `SHP-${String(shipment._id).slice(-6).toUpperCase()}` } } : {}) });
  } catch (err) {
    await shipmentRepo.deleteById(shipment._id); // اسمح بإعادة المحاولة بنفس المفتاح بعد فشل حقيقي
    throw err;
  }
}

// ---------------------------------------------------------------- نقل بين المستودع والمحل (جزئي، مع حفظ هوية الأرتال)
async function transfer({ modelNumber, items: rawItems, from, to, note = "" }) {
  if (from === to) throw badRequest("جهة المصدر والوجهة متطابقتان.", "SAME_LOCATION");
  const items = mergeItems(rawItems);
  const model0 = await activeModel(normalizeModelNumber(modelNumber));
  items.forEach((i) => requireSize(model0, i.size));

  const doc = await runAtomic(async (ctx) => {
    const moved = [];
    for (const i of items) {
      const taken = await seriesService.consume({ modelNumber: model0.modelNumber, modelId: model0._id, size: i.size, location: from, qty: i.qty }, ctx);
      const placed = await seriesService.depositDerived(taken, i.size, to, ctx);
      moved.push({ i, allocations: [...taken.map(strip), ...placed.map(strip)] });
    }
    const rows = [];
    for (const { i, allocations } of moved) {
      const { model, size } = await availability.hydratedSize(model0, i.size, ctx);
      const change = { [dk(from)]: -i.qty, [dk(to)]: i.qty };
      rows.push(movementService.buildRow({
        model, size, type: "transfer", qty: i.qty, delta: 0, from, to, before: movementService.beforeOf(size, change), after: movementService.pair(size),
        costUsd: i.qty * model.costPrice, reason: note, allocations,
      }));
    }
    await movementService.record(rows, ctx);
    return model0;
  });
  return result(doc);
}

// ---------------------------------------------------------------- تالف
async function damage({ modelNumber, size: rawSize, qty, location, reason }) {
  const size = normalizeSize(rawSize);
  const model0 = await activeModel(normalizeModelNumber(modelNumber));
  requireSize(model0, size);
  const doc = await runAtomic(async (ctx) => {
    const taken = await seriesService.consume({ modelNumber: model0.modelNumber, modelId: model0._id, size, location, qty }, ctx);
    const { model, size: s } = await availability.hydratedSize(model0, size, ctx);
    await movementService.record([
      movementService.buildRow({
        model, size: s, type: "damaged", qty, delta: -qty, from: location, before: movementService.beforeOf(s, { [dk(location)]: -qty }), after: movementService.pair(s),
        costUsd: qty * model.costPrice, reason, allocations: taken.map(strip),
      }),
    ], ctx);
    return model0;
  });
  return result(doc);
}

// ---------------------------------------------------------------- جرد فعلي (تعيين كمية مطلقة)
// النقص يُخصم FIFO من الأرتال؛ الزيادة تذهب إلى رتل الرصيد لأن الجرد لا يخلق رتلاً مستلماً
async function adjust({ modelNumber, size: rawSize, location, newQty, reason }) {
  const size = normalizeSize(rawSize);
  const model0 = await activeModel(normalizeModelNumber(modelNumber));
  requireSize(model0, size);

  const doc = await runAtomic(async (ctx) => {
    const cur = await availability.sizeQty(model0._id, size, ctx);
    const current = location === "shop" ? cur.shop : cur.warehouse;
    const delta = newQty - current;
    if (delta === 0) throw badRequest("الكمية الفعلية تطابق المسجّلة: لا يوجد فرق.", "NO_DIFFERENCE");

    const allocations = delta < 0
      ? (await seriesService.consume({ modelNumber: model0.modelNumber, modelId: model0._id, size, location, qty: -delta }, ctx)).map(strip)
      : [strip(await seriesService.depositBalance(model0, location, size, delta, ctx))];

    const { model, size: s } = await availability.hydratedSize(model0, size, ctx);
    await movementService.record([
      movementService.buildRow({
        model, size: s, type: "adjust", qty: Math.abs(delta), delta, [delta < 0 ? "from" : "to"]: location,
        before: movementService.beforeOf(s, { [dk(location)]: delta }), after: movementService.pair(s), costUsd: Math.abs(delta) * model.costPrice, reason, allocations,
      }),
    ], ctx);
    return model0;
  });
  return result(doc);
}

module.exports = { receiveShipment, transfer, damage, adjust, mergeItems };
