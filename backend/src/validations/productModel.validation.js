const { z, str, price, size, emptyToUndef, boolish, modelNumber, modelNumberParam, paging, dir } = require("./common");
const { ORIGINS } = require("../config/constants");
const { openingSeriesInput, MAX_SERIES_PER_RECEIVE } = require("./series.validation");

// مقاس الموديل: هوية فقط (الاسم والباركود). الكميات تأتي من الأرتال
const sizeInput = z.object({ size, barcode: emptyToUndef(z.string().trim().max(64).optional()) }).strict();

const list = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    brand: z.string().trim().max(60).optional(),
    type: z.string().trim().max(60).optional(),
    cut: z.string().trim().max(60).optional(),
    origin: z.enum(ORIGINS).optional(),
    status: z.enum(["out", "transfer"]).optional(),
    includeInactive: boolish.optional(),
    sort: z.enum(["name", "modelNumber", "updatedAt", "brand"]).optional(),
    dir,
    ...paging,
  }),
};

const facets = {};

const suggestNumber = { query: z.object({ brand: z.string().trim().max(60).optional() }) };

const create = {
  body: z
    .object({
      modelNumber: emptyToUndef(modelNumber.optional()),
      name: str("اسم الموديل"),
      brand: str("البراند", 60),
      origin: z.enum(ORIGINS, { errorMap: () => ({ message: "الأصل يجب أن يكون أجنبي أو وطني" }) }),
      type: str("نوع المنتج", 60),
      cut: z.string().trim().max(60).default(""),
      season: z.string().trim().max(60).default(""),
      notes: z.string().trim().max(300).default(""),
      costPrice: price("سعر الجملة"),
      sellPrice: price("سعر البيع"),
      sizes: z.array(sizeInput).min(1, "حدّد مقاساً واحداً على الأقل").max(30),
      openingSeries: z.array(openingSeriesInput).max(MAX_SERIES_PER_RECEIVE).optional(),
    })
    .strict(),
};

const get = { params: modelNumberParam };

const update = {
  params: modelNumberParam,
  body: z
    .object({
      name: str("اسم الموديل").optional(),
      brand: str("البراند", 60).optional(),
      origin: z.enum(ORIGINS).optional(),
      type: str("نوع المنتج", 60).optional(),
      cut: z.string().trim().max(60).optional(),
      season: z.string().trim().max(60).optional(),
      notes: z.string().trim().max(300).optional(),
      costPrice: price("سعر الجملة").optional(),
      sellPrice: price("سعر البيع").optional(),
      addSizes: z.array(sizeInput).max(30).optional(),
      removeSizes: z.array(size).max(30).optional(),
    })
    .strict(),
};

const archive = { params: modelNumberParam };
const restore = { params: modelNumberParam };
const qr = { params: modelNumberParam };

module.exports = { list, facets, suggestNumber, create, get, update, archive, restore, qr };
