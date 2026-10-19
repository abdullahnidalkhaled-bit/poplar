const Employee = require("../models/employee.model");
const { sessionOpts } = require("../utils/unitOfWork");

const create = async (data, ctx) => {
  const [doc] = await Employee.create([data], sessionOpts(ctx));
  return doc.toObject();
};
const deleteById = (id, ctx) => Employee.deleteOne({ _id: id }, sessionOpts(ctx));
const findById = (id, ctx) => Employee.findById(id, null, sessionOpts(ctx)).lean();
const findByUser = (user) => Employee.findOne({ user }).lean();
const findManyByIds = (ids) => Employee.find({ _id: { $in: ids } }).lean();
const update = (id, patch) => Employee.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after", runValidators: true }).lean();

const list = async (filter, { skip, limit }) => {
  const [items, total] = await Promise.all([
    Employee.find(filter).sort({ nameKey: 1, _id: 1 }).skip(skip).limit(limit).lean(),
    Employee.countDocuments(filter),
  ]);
  return { items, total };
};

module.exports = { create, deleteById, findById, findByUser, findManyByIds, update, list };
