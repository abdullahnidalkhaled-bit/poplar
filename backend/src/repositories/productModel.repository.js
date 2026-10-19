const ProductModel = require("../models/productModel.model");
const { sessionOpts } = require("../utils/unitOfWork");
const { escapeRegex } = require("../utils/text");

const qtyKey = (loc) => (loc === "shop" ? "shopQty" : "warehouseQty");

// ---------- قراءة ----------
const findById = (id, ctx) => ProductModel.findById(id, null, sessionOpts(ctx));
const findByModelNumber = (mn, ctx) => ProductModel.findOne({ modelNumber: mn }, null, sessionOpts(ctx));
const findByBarcode = (code, ctx) => ProductModel.findOne({ "sizes.barcode": code }, null, sessionOpts(ctx));
const modelNumberExists = async (mn, ctx) => !!(await ProductModel.exists({ modelNumber: mn }).session(ctx?.session ?? null));
const findByBarcodes = (codes, excludeId, ctx) => {
  const filter = { "sizes.barcode": { $in: codes } };
  if (excludeId) filter._id = { $ne: excludeId };
  return ProductModel.find(filter, "modelNumber sizes.barcode", sessionOpts(ctx));
};

const create = async (data, ctx) => {
  const [doc] = await ProductModel.create([data], sessionOpts(ctx));
  return doc;
};

// ---------- تحويل مرشّحات الواجهة إلى استعلام MongoDB ----------
// فلتر الحالة (نفاد/تحويل) لا يُبنى هنا: يأتي من availability.service كقائمة ids حتى لا تتكرر قواعد المخزون
function buildFilter({ brand, type, origin, cut, includeInactive, ids } = {}) {
  const f = {};
  if (!includeInactive) f.active = true;
  if (brand) f.brand = brand;
  if (type) f.type = type;
  if (origin) f.origin = origin;
  if (cut) f.cut = cut;
  if (ids) f._id = { $in: ids };
  return f;
}

const merge = (a, b) => (Object.keys(b).length ? { $and: [a, b] } : a);

// ---------- مراحل البحث (مرتّبة من الأدق للأوسع) ----------
const searchExact = (mn, filter) => ProductModel.findOne(merge({ modelNumber: mn }, filter));
const searchPrefix = (prefix, filter, limit) =>
  ProductModel.find(merge({ modelNumber: new RegExp(`^${escapeRegex(prefix)}`) }, filter)).sort({ modelNumber: 1 }).limit(limit);
// كل كلمات البحث يجب أن تبدأ بها كلمة من الاسم/البراند/النوع (يستخدم فهرس searchTokens)
const searchTokens = (tokens, filter, limit) =>
  ProductModel.find(merge({ $and: tokens.map((t) => ({ searchTokens: new RegExp(`^${escapeRegex(t)}`) })) }, filter))
    .sort({ name: 1 })
    .limit(limit);
// احتياطي: احتواء جزئي في أي موضع (للفهرس غير مفيد لكنه يُستخدم فقط عند عدم وجود نتائج)
const searchSubstring = (text, filter, limit) =>
  ProductModel.find(merge({ $or: [{ searchText: new RegExp(escapeRegex(text)) }, { modelNumber: new RegExp(escapeRegex(text.toUpperCase())) }] }, filter))
    .sort({ name: 1 })
    .limit(limit);

const list = async (filter, { skip, limit, sort }) => {
  const [items, total] = await Promise.all([
    ProductModel.find(filter).sort(sort).skip(skip).limit(limit),
    ProductModel.countDocuments(filter),
  ]);
  return { items, total };
};

const facets = async () => {
  const f = { active: true };
  const [brands, types, cuts] = await Promise.all([
    ProductModel.distinct("brand", f),
    ProductModel.distinct("type", f),
    ProductModel.distinct("cut", f),
  ]);
  const clean = (a) => a.filter(Boolean).sort((x, y) => x.localeCompare(y));
  return { brands: clean(brands), types: clean(types), cuts: clean(cuts) };
};

// ---------- تكلفة الموديل (المتوسط المرجّح) ----------
// تحكم تفاؤلي: يفشل (null) إن تغيّر المستند (rev) منذ قراءته
const setCostIfUnchanged = (modelId, expectRev, newCost, ctx) =>
  ProductModel.findOneAndUpdate(
    { _id: modelId, rev: expectRev },
    { $set: { costPrice: newCost }, $inc: { rev: 1 } },
    { returnDocument: "after", ...sessionOpts(ctx) }
  );
const forceCost = (modelId, cost, ctx) => ProductModel.updateOne({ _id: modelId }, { $set: { costPrice: cost } }, sessionOpts(ctx));

// إضافة مقاسات جديدة (لا تُضاف إن كان أحدها موجوداً: يمنع التكرار تحت التزامن)
const addSizes = (modelId, sizeDocs, ctx) =>
  ProductModel.findOneAndUpdate(
    { _id: modelId, "sizes.size": { $nin: sizeDocs.map((s) => s.size) } },
    { $push: { sizes: { $each: sizeDocs } }, $inc: { rev: 1 } },
    { returnDocument: "after", ...sessionOpts(ctx) }
  );

// يحذف مقاسات من الموديل (الخدمة تتحقق قبلها من خلوّها من المخزون)
const removeSizes = (modelId, sizeDocIds, ctx) =>
  ProductModel.updateOne({ _id: modelId }, { $pull: { sizes: { _id: { $in: sizeDocIds } } }, $inc: { rev: 1 } }, sessionOpts(ctx));

// قراءات خفيفة (lean) للنظرة العامة وفلاتر الحالة: الموديلات النشطة بمقاساتها فقط
const findActiveSizes = () => ProductModel.find({ active: true }).select("sizes.size").lean();
const findActiveOverview = () =>
  ProductModel.find({ active: true }).select("modelNumber name brand costPrice sellPrice sizes.size").sort({ modelNumber: 1 }).lean();

const deleteById = (id, ctx) => ProductModel.deleteOne({ _id: id }, sessionOpts(ctx));

module.exports = {
  qtyKey, findById, findByModelNumber, findByBarcode, findByBarcodes, modelNumberExists, create,
  buildFilter, searchExact, searchPrefix, searchTokens, searchSubstring, list, facets,
  setCostIfUnchanged, forceCost, addSizes, removeSizes, findActiveSizes, findActiveOverview, deleteById,
};
