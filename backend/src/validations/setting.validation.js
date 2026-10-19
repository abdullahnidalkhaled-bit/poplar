const { z, price, nonNegInt } = require("./common");

const get = {};
const update = {
  body: z.object({ usdToSyp: price("سعر الصرف").optional(), lowStockThreshold: nonNegInt("حد المخزون المنخفض").max(1000).optional() }).strict(),
};

module.exports = { get, update };
