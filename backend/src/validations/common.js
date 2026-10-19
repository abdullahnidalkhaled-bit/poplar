const { z } = require("zod");
const { LOCATIONS, MODEL_NUMBER_REGEX, SIZE_REGEX } = require("../config/constants");
const { normalizeModelNumber } = require("../utils/modelNumber");
const { normalizeSize } = require("../utils/sizes");

// رسائل خطأ عربية افتراضية لكل الحقول
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case "invalid_type":
      return { message: issue.received === "undefined" ? "حقل مطلوب" : "نوع القيمة غير صالح" };
    case "too_small":
      return { message: issue.type === "string" ? "النص قصير جداً" : issue.type === "array" ? "أضف عنصراً واحداً على الأقل" : `يجب ألا تقل القيمة عن ${issue.minimum}` };
    case "too_big":
      return { message: issue.type === "string" ? `النص أطول من ${issue.maximum} حرفاً` : issue.type === "array" ? `الحد الأقصى ${issue.maximum} عنصراً` : `يجب ألا تزيد القيمة عن ${issue.maximum}` };
    case "invalid_enum_value":
      return { message: "قيمة غير مسموحة" };
    case "unrecognized_keys":
      return { message: `حقول غير معروفة: ${issue.keys.join("، ")}` };
    default:
      return { message: ctx.defaultError };
  }
});

const label = (name) => ({ required_error: `${name} مطلوب`, invalid_type_error: `${name} غير صالح` });
const str = (name, max = 120) => z.string(label(name)).trim().min(1, `${name} مطلوب`).max(max, `${name} طويل جداً`);
const optStr = (max = 200) => z.string().trim().max(max).optional();
const emptyToUndef = (schema) => z.preprocess((v) => (v === "" || v === null ? undefined : v), schema);

const posInt = (name) => z.number(label(name)).int(`${name} يجب أن يكون عدداً صحيحاً`).min(1, `${name} يجب أن يكون 1 على الأقل`).max(1_000_000);
const nonNegInt = (name) => z.number(label(name)).int(`${name} يجب أن يكون عدداً صحيحاً`).min(0, `${name} لا يمكن أن يكون سالباً`).max(1_000_000);
const price = (name) => z.number(label(name)).min(0, `${name} لا يمكن أن يكون سالباً`).max(1_000_000_000);

const modelNumber = z
  .string(label("رقم الموديل"))
  .trim()
  .min(1, "رقم الموديل مطلوب")
  .refine((v) => !/\s/.test(v), "رقم الموديل لا يحتوي مسافات")
  .transform(normalizeModelNumber)
  .refine((v) => MODEL_NUMBER_REGEX.test(v), "رقم الموديل غير صالح: أحرف إنجليزية وأرقام وشرطة (مثل FAF-001)");

const size = z
  .string(label("المقاس"))
  .trim()
  .min(1, "المقاس مطلوب")
  .transform(normalizeSize)
  .refine((v) => SIZE_REGEX.test(v), "مقاس غير صالح (مثل S أو XL أو 38)");

const objectId = (name) => z.string(label(name)).regex(/^[a-f\d]{24}$/i, `${name} غير صالح`);
const location = z.enum(LOCATIONS, { errorMap: () => ({ message: "الموقع يجب أن يكون المحل أو المستودع" }) });
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "تاريخ غير صالح");
const boolish = z.preprocess((v) => v === true || v === "true", z.boolean());

// ترقيم الصفحات المشترك بين قوائم الاستعلام
const paging = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};
const dir = z.enum(["asc", "desc"]).optional();

// بارامترات مشتركة بين عدة موارد
const modelNumberParam = z.object({ modelNumber });
const idParam = z.object({ id: objectId("المعرّف") });
const rangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

module.exports = {
  z, label, str, optStr, emptyToUndef, posInt, nonNegInt, price, modelNumber, size, objectId, location, isoDate, boolish,
  paging, dir, modelNumberParam, idParam, rangeQuery,
};
