const { z, nonNegInt, posInt, objectId, rangeQuery } = require("./common");
const { CURRENCIES } = require("../config/constants");
const { saleItems } = require("./invoice.validation");

const create = {
  body: z
    .object({
      invoiceId: objectId("معرّف الفاتورة"),
      items: z.array(z.object({ itemIndex: nonNegInt("البند"), qty: posInt("الكمية"), condition: z.enum(["good", "damaged"]).default("good") }).strict()).min(1, "اختر قطعة للإرجاع").max(100),
      reason: z.string().trim().max(200).default(""),
      mode: z.enum(["cash", "exchange"]).default("cash"),
      newInvoice: z.object({ items: saleItems, currency: z.enum(CURRENCIES).default("USD") }).strict().optional(),
    })
    .strict(),
};

const list = { query: rangeQuery };

module.exports = { create, list };
