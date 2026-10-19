const Session = require("../models/session.model");

const create = (data) => Session.create(data);
const findByHash = (sidHash) => Session.findOne({ sidHash }).lean();
const deleteByHash = (sidHash) => Session.deleteOne({ sidHash });
const deleteByUser = (userId) => Session.deleteMany({ user: userId });
const deleteOthersOfUser = (userId, keepHash) => Session.deleteMany({ user: userId, sidHash: { $ne: keepHash } });
const touch = (sidHash, at) => Session.updateOne({ sidHash }, { $set: { lastSeenAt: at } });

module.exports = { create, findByHash, deleteByHash, deleteByUser, deleteOthersOfUser, touch };
