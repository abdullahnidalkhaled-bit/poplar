const { z, label, str, optStr, objectId, isoDate, paging } = require("./common");

const currency = z.enum(["USD", "SYP"], { errorMap: () => ({ message: "العملة يجب أن تكون USD أو SYP" }) });
const amount = z.number(label("المبلغ")).positive("المبلغ يجب أن يكون أكبر من صفر").max(1_000_000_000_000, "المبلغ كبير جداً");
const key = z.string(label("مفتاح الطلب")).min(8, "مفتاح الطلب قصير").max(100);

const dashboard = { query: z.object({ from: isoDate, to: isoDate, tz: z.string().max(60).optional() }) };
const cashList = { query: z.object({ currency: currency.optional(), type: z.string().max(40).optional(), from: isoDate.optional(), to: isoDate.optional(), ...paging }) };
const cashManual = {
  body: z.object({ currency, direction: z.enum(["in", "out"]), amount, note: str("البيان", 300), date: isoDate.optional(), idempotencyKey: key }).strict(),
};
const cashReverse = { params: z.object({ id: objectId("المعرّف") }), body: z.object({ reason: str("سبب العكس", 300) }).strict() };
const expenseList = { query: z.object({ currency: currency.optional(), from: isoDate.optional(), to: isoDate.optional(), ...paging }) };
const periodKeyRe = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الفترة بصيغة YYYY-MM");
const expenseCreate = {
  // مصروف الرواتب: employeeId إلزامي لفئة الرواتب (يتحقق منه الخادم)، والفترة تُحلّ تلقائياً ما لم تُحدَّد، والدفع نقداً أو من خارج الصندوق
  body: z.object({
    currency, amount, category: str("الفئة", 60), description: optStr(300), date: isoDate.optional(), idempotencyKey: key,
    employeeId: objectId("الموظف").optional(), periodKey: periodKeyRe.optional(), method: z.enum(["cash", "other"]).optional(),
  }).strict(),
};
const expenseReverse = { params: z.object({ id: objectId("المعرّف") }), body: z.object({ reason: str("سبب العكس", 300) }).strict() };

module.exports = { dashboard, cashList, cashManual, cashReverse, expenseList, expenseCreate, expenseReverse };
