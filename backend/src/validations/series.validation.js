const { z, size, location, isoDate, label, paging, dir } = require("./common");
const { LOCATIONS, MAX_SERIES_PER_RECEIVE } = require("../config/constants");
const { validateSeriesComposition } = require("../utils/series");

// رتل: مقاسات بكميات؛ القاعدة (1 أو 2 لكل مقاس، غير فارغ) تأتي من utils/series كمصدر وحيد
const seriesSizes = z
  .array(z.object({ size, qty: z.number(label("الكمية")).int("الكمية يجب أن تكون عدداً صحيحاً") }).strict(), label("مقاسات الرتل"))
  .superRefine((sizes, ctx) => {
    for (const message of validateSeriesComposition(sizes)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

// رتل ضمن شحنة (الموقع من الشحنة نفسها)
const seriesInput = z.object({ sizes: seriesSizes }).strict();
// رتل افتتاحي عند إنشاء موديل (موقعه خاص به)
const openingSeriesInput = z.object({ location, sizes: seriesSizes }).strict();

// سجل الأرتال: بحث بالرقم/الموديل/الاسم + موقع + نطاق تاريخ + ترتيب + ترقيم
const list = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    location: z.enum(LOCATIONS).optional(),
    status: z.enum(["active", "depleted"]).optional(),
    ownership: z.enum(["owned", "consignment"]).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    sort: z.enum(["receivedAt", "createdAt", "seriesNo", "modelNumber"]).optional(),
    dir,
    ...paging,
  }),
};

const detail = {
  params: z.object({ seriesNo: z.string().trim().regex(/^SER-\d{1,12}$/i, "رقم الرتل غير صالح (مثل SER-000123)") }),
};

module.exports = { list, detail, seriesInput, openingSeriesInput, MAX_SERIES_PER_RECEIVE };
