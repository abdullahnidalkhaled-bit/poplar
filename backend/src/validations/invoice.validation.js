const { z, optStr, posInt, price, objectId, idParam, rangeQuery } = require("./common");
const { CURRENCIES } = require("../config/constants");

// بنود البيع: مشتركة مع فاتورة التبديل داخل المرتجعات
const saleItems = z
  .array(z.object({ modelId: objectId("معرّف الموديل"), sizeId: objectId("معرّف المقاس"), qty: posInt("الكمية"), unitPrice: price("السعر") }).strict())
  .min(1, "الفاتورة فارغة")
  .max(100);

const create = { body: z.object({ items: saleItems, currency: z.enum(CURRENCIES).default("USD"), note: optStr(200) }).strict() };
const list = { query: rangeQuery };
const get = { params: idParam };
const cancel = { params: idParam };

module.exports = { create, list, get, cancel, saleItems };
