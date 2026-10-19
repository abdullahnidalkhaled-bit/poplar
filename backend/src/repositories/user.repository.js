const User = require("../models/user.model");

const findById = (id) => User.findById(id).lean();
const findByUsername = (username) => User.findOne({ username }).lean();
const list = () => User.find().sort({ createdAt: 1 }).lean();
const create = async (data) => (await User.create(data)).toObject();
const countAdmins = () => User.countDocuments({ role: "admin" });
const update = (id, patch) => User.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" }).lean();
// يزيد tokenVersion ذرّياً مع التعديل: أي جلسة سابقة تسقط
const updateAndRevoke = (id, patch) => User.findByIdAndUpdate(id, { $set: patch, $inc: { tokenVersion: 1 } }, { returnDocument: "after" }).lean();

module.exports = { findById, findByUsername, list, create, countAdmins, update, updateAndRevoke };
