const { z, label, str, optStr, objectId, idParam, isoDate, posInt, size, location, paging, boolish } = require("./common");

const key = z.string(label("مفتاح الطلب")).min(8, "مفتاح الطلب قصير").max(100);
const currency = z.enum(["USD", "SYP"], { errorMap: () => ({ message: "العملة يجب أن تكون USD أو SYP" }) });
const amount = z.number(label("المبلغ")).positive("المبلغ يجب أن يكون أكبر من صفر").max(1_000_000_000_000, "المبلغ كبير جداً");
const rate = z.number(label("سعر الصرف")).positive("سعر الصرف غير صالح").max(1_000_000_000);
const money = { amount, currency: currency.default("USD"), rate: rate.optional() };

const entryIdParams = z.object({ id: objectId("المعرّف"), entryId: objectId("القيد") });
const supplierIdParam = idParam;

const fields = {
  name: str("اسم التاجر", 120),
  phone: optStr(40),
  address: optStr(300),
  notes: optStr(1000),
};

const list = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    active: z.enum(["true", "false", "all"]).optional(),
    account: z.enum(["due", "advance", "mixed", "settled"]).optional(),
    ...paging,
  }),
};
const summary = {};
const create = { body: z.object({ ...fields, allowDuplicate: z.boolean().optional() }).strict() };
const update = {
  params: supplierIdParam,
  body: z.object({
    name: fields.name.optional(), phone: fields.phone, address: fields.address, notes: fields.notes,
    active: z.boolean().optional(), allowDuplicate: z.boolean().optional(),
  }).strict(),
};
const detail = { params: supplierIdParam };

const ledger = {
  params: supplierIdParam,
  query: z.object({
    from: isoDate.optional(), to: isoDate.optional(),
    type: z.enum(["purchase", "adjustment", "payment", "advance", "credit", "return_credit", "reversal"]).optional(),
    currency: currency.optional(),
    ...paging,
  }),
};

const invoiceList = { params: supplierIdParam };
const createInvoice = {
  params: supplierIdParam,
  body: z.object({
    invoiceNo: str("رقم فاتورة التاجر", 60),
    invoiceDate: isoDate, dueDate: isoDate.optional(),
    ...money,
    terms: optStr(200), note: optStr(500),
    seriesNos: z.array(z.string().trim().regex(/^SER-\d{1,12}$/i, "رقم رتل غير صالح")).max(60).optional(),
    shipmentRefs: z.array(z.string().trim().min(1).max(40)).max(60).optional(),
    idempotencyKey: key,
  }).strict(),
};

// دفع بعملة تختلف عن عملة الفاتورة: تأكيد صريح بمبلغ التسوية بعملة الفاتورة وسعر الصرف المُدخَل (ل.س لكل 1$)
const crossCurrency = z.object({ settlesAmount: z.number(label("مبلغ التسوية")).positive().max(1_000_000_000_000), rate: rate }).strict();
const payment = {
  params: supplierIdParam,
  body: z.object({ ...money, invoiceId: objectId("الفاتورة").optional(), crossCurrency: crossCurrency.optional(), date: isoDate.optional(), note: optStr(500), idempotencyKey: key }).strict(),
};
const advance = {
  params: supplierIdParam,
  body: z.object({ ...money, date: isoDate.optional(), note: optStr(500), idempotencyKey: key }).strict(),
};
// إشعار دائن (يخفض المستحق) أو تسوية مدينة (تزيده): السبب إلزامي لأنها قيود يدوية
const adjustment = {
  params: supplierIdParam,
  body: z.object({
    kind: z.enum(["credit", "adjustment"]), ...money, invoiceId: objectId("الفاتورة").optional(),
    date: isoDate.optional(), note: str("سبب القيد", 500), idempotencyKey: key,
  }).strict(),
};
const allocate = {
  params: supplierIdParam,
  body: z.object({ entryId: objectId("القيد"), invoiceId: objectId("الفاتورة"), amount, creditAmount: amount.optional(), crossCurrency: z.boolean().optional(), rate: rate.optional(), note: optStr(500), idempotencyKey: key }).strict(),
};
const autoAllocate = { params: supplierIdParam, body: z.object({ entryId: objectId("القيد").optional() }).strict() };
const allocationList = { params: supplierIdParam };
const releaseAllocation = { params: z.object({ id: objectId("المعرّف"), allocId: objectId("التخصيص") }), body: z.object({ reason: str("سبب التحرير", 500) }).strict() };
const settlementList = { params: supplierIdParam };
const settlementEligible = { params: supplierIdParam };
const settle = {
  params: supplierIdParam,
  body: z.object({ items: z.array(z.object({ seriesId: objectId("الرتل"), size, qty: posInt("الكمية") }).strict()).min(1, "اختر بنداً واحداً على الأقل").max(100), note: optStr(500), idempotencyKey: key }).strict(),
};
const reverseSettlement = { params: z.object({ id: objectId("المعرّف"), settlementId: objectId("التسوية") }), body: z.object({ reason: str("سبب العكس", 500) }).strict() };
const setPrice = {
  params: supplierIdParam,
  body: z.object({
    seriesIds: z.array(objectId("الرتل")).min(1, "اختر رتلاً واحداً على الأقل").max(100),
    price: z.object({ amount, currency: currency.default("USD"), rate: rate.optional() }).strict(),
    adjust: z.boolean().optional(), reason: str("سبب/مرجع الاتفاق", 300),
  }).strict(),
};
const reverse = { params: entryIdParams, body: z.object({ reason: str("سبب العكس", 500) }).strict() };

const consignment = {
  params: supplierIdParam,
  query: z.object({ q: z.string().trim().max(100).optional(), location: location.optional(), includeEmpty: boolish.optional() }),
};
const returnList = { params: supplierIdParam };
const createReturn = {
  params: supplierIdParam,
  body: z.object({
    items: z.array(z.object({ seriesId: objectId("الرتل"), size, qty: posInt("الكمية") }).strict()).min(1, "اختر قطعة واحدة على الأقل").max(100),
    reason: str("سبب الإرجاع", 300),
    idempotencyKey: key,
    // قيد دائن مالي اختياري: فقط حين كانت القطع المُرجَعة قد دخلت في التزام أو دُفع ثمنها
    credit: z.object({ ...money, invoiceId: objectId("الفاتورة").optional(), note: optStr(500) }).strict().optional(),
  }).strict(),
};

module.exports = { allocate, autoAllocate, allocationList, releaseAllocation, settlementList, settlementEligible, settle, reverseSettlement, setPrice, list, summary, create, update, detail, ledger, invoiceList, createInvoice, payment, advance, adjustment, reverse, consignment, returnList, createReturn };
