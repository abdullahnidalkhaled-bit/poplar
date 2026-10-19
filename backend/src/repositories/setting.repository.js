const Setting = require("../models/setting.model");

const base = { key: "main" };

// يعيد الإعدادات (وينشئها عند أول استخدام) مع تطبيق patch اختياري
const upsertMain = (patch = {}) => {
  const update = { $setOnInsert: base };
  if (Object.keys(patch).length) update.$set = patch;
  return Setting.findOneAndUpdate(base, update, { upsert: true, returnDocument: "after" });
};

module.exports = { upsertMain };
