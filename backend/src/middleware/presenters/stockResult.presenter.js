const { presentModel } = require("./model.presenter");

// نتيجة عملية مخزون: { model, duplicate?, series? }
const present = (payload) => ({ ...payload, model: presentModel(payload.model) });

module.exports = { name: "stockResult", present };
