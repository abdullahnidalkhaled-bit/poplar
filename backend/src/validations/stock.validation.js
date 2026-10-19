const { z, str, optStr, isoDate, size, posInt, nonNegInt, price, location, label, modelNumber, objectId } = require("./common");
const { seriesInput, MAX_SERIES_PER_RECEIVE } = require("./series.validation");

const stockItems = z.array(z.object({ size, qty: posInt("الكمية") }).strict()).min(1, "أضف مقاساً واحداً على الأقل").max(30);

// فاتورة شراء تُنشأ مع الاستلام (شراء عادي فقط): المبلغ بعملة الفاتورة، والدفع النقدي الآن (اختياري) وتخصيص سلف قائمة (اختياري)
const purchaseInput = z
  .object({
    invoiceNo: str("رقم فاتورة التاجر", 60),
    invoiceDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    currency: z.enum(["USD", "SYP"]).default("USD"),
    amount: z.number(label("قيمة الفاتورة")).positive("قيمة الفاتورة يجب أن تكون أكبر من صفر").max(1_000_000_000_000),
    rate: z.number().positive().max(1_000_000_000).optional(),
    terms: optStr(200),
    payment: z
      .object({
        cashAmount: z.number(label("المبلغ المدفوع الآن")).positive("المبلغ المدفوع يجب أن يكون أكبر من صفر").max(1_000_000_000_000).optional(),
        advances: z.array(z.object({ entryId: objectId("السلفة"), amount: z.number(label("المبلغ")).positive().max(1_000_000_000_000) }).strict()).max(10).optional(),
        date: isoDate.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const receive = {
  body: z
    .object({
      modelNumber,
      series: z.array(seriesInput).min(1, "أضف رتلاً واحداً على الأقل").max(MAX_SERIES_PER_RECEIVE),
      location: location.default("warehouse"),
      unitCostUsd: price("سعر الجملة").optional(),
      idempotencyKey: z.string(label("مفتاح الطلب")).min(8, "مفتاح الطلب قصير").max(100),
      note: optStr(200),
      // ملكية الشحنة (للمالك فقط): التاجر وكونها بضاعة أمانة
      supplierId: objectId("التاجر").optional(),
      consignment: z.boolean().optional(),
      // سعر الاتفاق للقطعة (بضاعة الأمانة): يُحفظ لقطةً مع الرتل ويُستعمل لاحقاً في التسوية
      purchase: purchaseInput.optional(),
      consignmentPrice: z.object({ amount: z.number(label("سعر الاتفاق")).positive("سعر الاتفاق يجب أن يكون أكبر من صفر").max(1_000_000_000), currency: z.enum(["USD", "SYP"]).default("USD"), rate: z.number().positive().max(1_000_000_000).optional() }).strict().optional(),
    })
    .strict()
    .refine((b) => !b.consignment || b.supplierId, { message: "بضاعة الأمانة تتطلب تحديد التاجر", path: ["supplierId"] })
    .refine((b) => !b.purchase || b.supplierId, { message: "فاتورة الشراء تتطلب تحديد التاجر", path: ["purchase"] })
    .refine((b) => !b.purchase || !b.consignment, { message: "بضاعة الأمانة لا تُنشئ فاتورة شراء: تُسوّى لاحقاً بعد البيع", path: ["purchase"] }),
};

const transfer = { body: z.object({ modelNumber, items: stockItems, from: location, to: location, note: optStr(200) }).strict() };

const damage = { body: z.object({ modelNumber, size, qty: posInt("الكمية"), location, reason: str("سبب التلف", 200) }).strict() };

const adjust = { body: z.object({ modelNumber, size, location, newQty: nonNegInt("الكمية الفعلية"), reason: str("سبب التعديل", 200) }).strict() };

module.exports = { receive, transfer, damage, adjust };
