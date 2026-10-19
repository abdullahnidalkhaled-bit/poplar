const Shipment = require("../models/shipment.model");

const create = (data) => Shipment.create(data);
const findByKey = (idempotencyKey) => Shipment.findOne({ idempotencyKey });
const markApplied = (id, seriesIds, invoice) => Shipment.updateOne({ _id: id }, { status: "applied", seriesIds, ...(invoice ? { invoice } : {}) });
const deleteById = (id) => Shipment.deleteOne({ _id: id });

module.exports = { create, findByKey, markApplied, deleteById };
