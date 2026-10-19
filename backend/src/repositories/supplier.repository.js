const Supplier = require("../models/supplier.model");
const { sessionOpts } = require("../utils/unitOfWork");

const findById = (id, ctx) => Supplier.findById(id, null, sessionOpts(ctx)).lean();
const findByIds = (ids) => Supplier.find({ _id: { $in: ids } }).lean();
const create = async (data) => (await Supplier.create(data)).toObject();
const update = (id, patch) => Supplier.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" }).lean();

// تكرار محتمل: نفس الاسم المطبّع مع نفس الهاتف (الاسم وحده لا يكفي لاعتبار التاجرين واحداً)
const findDuplicate = (nameKey, phoneKey, excludeId) =>
  Supplier.findOne({ nameKey, phoneKey, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).lean();

const list = async (filter, { sort, skip, limit }) => {
  const [items, total] = await Promise.all([
    Supplier.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Supplier.countDocuments(filter),
  ]);
  return { items, total };
};

const countActive = () => Supplier.countDocuments({ active: true });
const allIds = async (filter = {}) => (await Supplier.find(filter).select("_id").lean()).map((s) => String(s._id));

// قفل منطقي لكل تاجر: كتابة على وثيقة التاجر داخل المعاملة تُحدث تعارض كتابة بين التخصيصات المتزامنة فتُسلسَل (لا فرط تخصيص تحت عزل اللقطة)
const touchLock = (id, ctx) => Supplier.collection.updateOne({ _id: id }, { $inc: { ledgerLock: 1 } }, sessionOpts(ctx));

module.exports = { touchLock, findById, findByIds, create, update, findDuplicate, list, countActive, allIds };
