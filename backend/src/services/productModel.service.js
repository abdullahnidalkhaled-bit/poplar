const QRCode = require("qrcode");
const repo = require("../repositories/productModel.repository");
const { nextSeq, peekSeq } = require("../repositories/counter.repository");
const seriesService = require("./series.service");
const availability = require("./availability.service");
const movementService = require("./movement.service");
const { normalizeModelNumber, isValidModelNumber, brandPrefix, formatModelNumber } = require("../utils/modelNumber");
const { normalizeSize } = require("../utils/sizes");
const { normalizeText, tokenize } = require("../utils/text");
const { runAtomic } = require("../utils/unitOfWork");
const { parsePaging, pageResult } = require("../utils/pagination");
const { notFound, badRequest, conflict } = require("../utils/errors");
const { QR_PREFIX, QR_VERSION } = require("../config/constants");

// الخدمة تعيد بيانات خام (الكميات من الأرتال عبر availability.service)؛ الحقول المشتقة للعرض يضيفها عارض النموذج

// ---------------------------------------------------------------- رقم الموديل
// يولّد رقماً فريداً BRAND-001 ويتخطى الأرقام المستخدمة يدوياً
async function generateModelNumber(brand, ctx) {
  const prefix = brandPrefix(brand);
  for (let i = 0; i < 50; i++) {
    const candidate = formatModelNumber(prefix, await nextSeq(`modelno:${prefix}`, ctx));
    if (!(await repo.modelNumberExists(candidate, ctx))) return candidate;
  }
  throw conflict("تعذّر توليد رقم موديل فريد، حاول مجدداً", "MODEL_NUMBER_EXHAUSTED");
}

// اقتراح للواجهة دون استهلاك العدّاد
async function suggestModelNumber(brand) {
  const prefix = brandPrefix(brand);
  let seq = await peekSeq(`modelno:${prefix}`);
  for (let i = 0; i < 50; i++) {
    const candidate = formatModelNumber(prefix, ++seq);
    if (!(await repo.modelNumberExists(candidate))) return candidate;
  }
  return formatModelNumber(prefix, seq + 1);
}

// رقم مُدخل يدوياً (من الملصق الفعلي) أو مولَّد تلقائياً
async function resolveModelNumber(input, brand, ctx) {
  if (!input) return generateModelNumber(brand, ctx);
  const mn = normalizeModelNumber(input);
  if (!isValidModelNumber(mn)) {
    throw badRequest("رقم الموديل غير صالح: أحرف إنجليزية كبيرة وأرقام وشرطة فقط (مثل FAF-001).", "INVALID_MODEL_NUMBER");
  }
  if (await repo.modelNumberExists(mn, ctx)) {
    throw conflict(`رقم الموديل ${mn} مستخدم مسبقاً لموديل آخر.`, "MODEL_NUMBER_TAKEN");
  }
  return mn;
}

// ---------------------------------------------------------------- مقاسات وباركود
const nextBarcode = async (ctx) => `POP-${String(await nextSeq("barcode", ctx)).padStart(6, "0")}`;

// ينظّف المقاسات المُدخلة، يمنع تكرار المقاس/الباركود، ويولّد باركوداً داخلياً لما بلا باركود
async function prepareSizes(input, { excludeId, ctx } = {}) {
  const seen = new Set();
  const out = input.map((s) => {
    const size = normalizeSize(s.size);
    if (seen.has(size)) throw badRequest(`المقاس ${size} مكرر.`, "DUPLICATE_SIZE");
    seen.add(size);
    return { size, barcode: String(s.barcode || "").trim() };
  });

  const given = out.map((s) => s.barcode).filter(Boolean);
  const dup = given.find((c, i) => given.indexOf(c) !== i);
  if (dup) throw conflict(`الباركود ${dup} مكرر داخل الموديل نفسه.`, "BARCODE_TAKEN");
  if (given.length) {
    const clash = await repo.findByBarcodes(given, excludeId, ctx);
    if (clash.length) {
      const code = clash[0].sizes.find((s) => given.includes(s.barcode)).barcode;
      throw conflict(`الباركود ${code} مستخدم في الموديل ${clash[0].modelNumber}.`, "BARCODE_TAKEN");
    }
  }
  for (const s of out) if (!s.barcode) s.barcode = await nextBarcode(ctx);
  return out;
}

async function requireModel(modelNumber, ctx) {
  const doc = await repo.findByModelNumber(normalizeModelNumber(modelNumber), ctx);
  if (!doc) throw notFound(`الموديل ${modelNumber} غير موجود.`, "MODEL_NOT_FOUND");
  return doc;
}

const getDetail = async (modelNumber) => availability.hydrate(await requireModel(modelNumber));

// ---------------------------------------------------------------- إنشاء وتعديل
async function createModel(input) {
  const doc = await runAtomic(async (ctx) => {
    const modelNumber = await resolveModelNumber(input.modelNumber, input.brand, ctx);
    const sizes = await prepareSizes(input.sizes, { ctx });
    const created = await repo.create(
      {
        modelNumber, sizes,
        name: input.name, brand: input.brand, origin: input.origin, type: input.type,
        cut: input.cut, season: input.season, notes: input.notes,
        costPrice: input.costPrice, sellPrice: input.sellPrice,
      },
      ctx
    );
    ctx.undo(() => repo.deleteById(created._id));

    // الرصيد الافتتاحي = أرتال مستلمة (تخضع لقاعدة 1-2)، وكل (رتل، مقاس) حركة استلام
    const names = new Set(created.sizes.map((s) => s.size));
    const rows = [];
    const running = { shop: new Map(), warehouse: new Map() }; // الكمية التراكمية لكل مقاس وموقع
    for (const os of input.openingSeries || []) {
      const missing = os.sizes.map((x) => normalizeSize(x.size)).find((n) => !names.has(n));
      if (missing) throw badRequest(`المقاس ${missing} في الرتل الافتتاحي غير مضاف إلى مقاسات الموديل.`, "SIZE_NOT_IN_MODEL");
      const doc = await seriesService.createReceived(created, { location: os.location, sizes: os.sizes, shipmentRef: "OPENING", note: "رصيد افتتاحي" }, ctx);
      for (const x of doc.sizes) {
        const size = created.sizes.find((s) => s.size === x.size);
        const run = running[os.location];
        const startQty = run.get(x.size) || 0;
        run.set(x.size, startQty + x.qty);
        const other = running[os.location === "shop" ? "warehouse" : "shop"].get(x.size) || 0;
        const before = os.location === "shop" ? { shop: startQty, warehouse: other } : { shop: other, warehouse: startQty };
        const after = os.location === "shop" ? { shop: startQty + x.qty, warehouse: other } : { shop: other, warehouse: startQty + x.qty };
        rows.push(movementService.buildRow({
          model: created, size, type: "receive", qty: x.qty, delta: x.qty, to: os.location, before, after,
          costUsd: x.qty * created.costPrice, reason: "رصيد افتتاحي عند إنشاء الموديل", ref: doc.seriesNo,
          allocations: [{ series: doc._id, seriesNo: doc.seriesNo, qty: x.qty, location: os.location }],
        }));
      }
    }
    await movementService.record(rows, ctx);
    return created;
  });
  return availability.hydrate(doc);
}

// تعديل بيانات الموديل. رقم الموديل ثابت ولا يتغير (QR والفواتير تعتمد عليه)
async function updateModel(modelNumber, patch) {
  const doc = await requireModel(modelNumber);
  for (const k of ["name", "brand", "origin", "type", "cut", "season", "notes", "costPrice", "sellPrice"]) {
    if (patch[k] !== undefined) doc.set(k, patch[k]);
  }
  await doc.save();

  if (patch.removeSizes?.length) {
    const names = patch.removeSizes.map(normalizeSize);
    const targets = doc.sizes.filter((s) => names.includes(s.size));
    const missing = names.filter((n) => !targets.some((t) => t.size === n));
    if (missing.length) throw notFound(`المقاس ${missing[0]} غير موجود في هذا الموديل.`, "SIZE_NOT_FOUND");
    const hydrated = await availability.hydrate(doc);
    const stocked = hydrated.sizes.find((s) => names.includes(s.size) && s.shopQty + s.warehouseQty > 0);
    if (stocked) throw conflict(`لا يمكن حذف المقاس ${stocked.size} لأن له مخزوناً. انقل أو أتلف أو عدّل كميته أولاً.`, "SIZE_HAS_STOCK");
    if (targets.length >= doc.sizes.length && !patch.addSizes?.length) {
      throw badRequest("لا يمكن حذف كل المقاسات: يجب أن يبقى مقاس واحد على الأقل.", "LAST_SIZE");
    }
    await repo.removeSizes(doc._id, targets.map((t) => t._id));
  }

  if (patch.addSizes?.length) {
    const fresh = await repo.findById(doc._id);
    const sizes = await prepareSizes(patch.addSizes, { excludeId: doc._id });
    const exists = sizes.find((s) => fresh.sizes.some((x) => x.size === s.size));
    if (exists) throw conflict(`المقاس ${exists.size} موجود مسبقاً في الموديل.`, "SIZE_EXISTS");
    if (!(await repo.addSizes(doc._id, sizes))) throw conflict("تغيّرت مقاسات الموديل، أعد المحاولة.", "CONFLICT");
  }
  return availability.hydrate(await repo.findById(doc._id));
}

// أرشفة بدل الحذف: تبقى الفواتير والسجل سليمة، ولا يُباع الموديل أو يُستلم
async function setActive(modelNumber, active) {
  const doc = await requireModel(modelNumber);
  doc.active = active;
  await doc.save();
  return availability.hydrate(doc);
}

// ---------------------------------------------------------------- البحث
const MATCH = { EXACT: "model_number_exact", PREFIX: "model_number_prefix", NAME: "name", PARTIAL: "partial" };

/**
 * بحث ذكي بأولويات:
 *  1) رقم الموديل مطابق تماماً   2) رقم الموديل يبدأ بالنص
 *  3) كلمات الاسم/البراند/النوع (كل كلمة تُطابَق من بدايتها)   4) احتواء جزئي (احتياطي عند انعدام النتائج)
 */
async function search(rawQuery, filters = {}, { limit = 20 } = {}) {
  const q = normalizeText(rawQuery);
  if (!q) return { query: "", items: [], exact: false };

  const { status, ...rest } = filters;
  if (status) rest.ids = await availability.modelIdsByStatus(status);
  const filter = repo.buildFilter(rest);
  const mn = normalizeModelNumber(rawQuery);

  const seen = new Set();
  const found = [];
  const push = (docs, matchType) => {
    for (const d of [].concat(docs || [])) {
      const id = String(d._id);
      if (seen.has(id) || found.length >= limit) continue;
      seen.add(id);
      found.push({ matchType, doc: d });
    }
  };

  if (isValidModelNumber(mn)) push(await repo.searchExact(mn, filter), MATCH.EXACT);
  if (mn.length >= 2) push(await repo.searchPrefix(mn, filter, limit), MATCH.PREFIX);
  const tokens = tokenize(rawQuery);
  if (tokens.length) push(await repo.searchTokens(tokens, filter, limit), MATCH.NAME);
  if (!found.length && q.length >= 2) push(await repo.searchSubstring(q, filter, limit), MATCH.PARTIAL);

  const hydrated = await availability.hydrateMany(found.map((f) => f.doc));
  const items = found.map((f, i) => ({ matchType: f.matchType, ...hydrated[i] }));
  return { query: q, items, exact: items[0]?.matchType === MATCH.EXACT };
}

// ---------------------------------------------------------------- قائمة وواجهات مساعدة
const SORTS = { name: "name", modelNumber: "modelNumber", updatedAt: "updatedAt", brand: "brand" };

async function listModels(query) {
  const filters = { brand: query.brand, type: query.type, origin: query.origin, cut: query.cut, includeInactive: query.includeInactive };
  if (query.q && query.q.trim()) {
    if (query.status) filters.status = query.status;
    const limit = parsePaging(query).limit;
    const res = await search(query.q, filters, { limit });
    return { ...pageResult(res.items, res.items.length, { page: 1, limit }), query: res.query, exact: res.exact };
  }
  // فلتر الحالة (نفاد/تحويل) من availability.service: مصدر قواعد التوفر الوحيد
  if (query.status) filters.ids = await availability.modelIdsByStatus(query.status);
  const paging = parsePaging(query);
  const sortField = SORTS[query.sort] || "updatedAt";
  const dir = query.dir === "desc" ? -1 : query.dir === "asc" ? 1 : query.sort ? 1 : -1;
  const { items, total } = await repo.list(repo.buildFilter(filters), { ...paging, sort: { [sortField]: dir, _id: 1 } });
  return pageResult(await availability.hydrateMany(items), total, paging);
}

const facets = () => repo.facets();

// يولّد حمولة QR (PLP1:FAF-001) وصورة SVG جاهزة للطباعة لموديل موجود
async function qr(modelNumber) {
  const model = await requireModel(modelNumber);
  const payload = `${QR_PREFIX}${QR_VERSION}:${model.modelNumber}`;
  const svg = await QRCode.toString(payload, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
  return { modelNumber: model.modelNumber, name: model.name, payload, svg };
}

module.exports = { requireModel, getDetail, createModel, updateModel, setActive, listModels, facets, suggestModelNumber, qr, search, prepareSizes, MATCH };
