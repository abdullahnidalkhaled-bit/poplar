const { z, label, str, optStr, objectId, isoDate, paging, idParam } = require("./common");
const { EMPLOYEE_STATUSES, PAYROLL_STATUSES, ADVANCE_STATUSES, PAYROLL_LEDGER_TYPES } = require("../config/constants");

const currency = z.enum(["USD", "SYP"], { errorMap: () => ({ message: "العملة يجب أن تكون USD أو SYP" }) });
const amount = z.number(label("المبلغ")).positive("المبلغ يجب أن يكون أكبر من صفر").max(1_000_000_000_000, "المبلغ كبير جداً");
const salary = z.number(label("الراتب")).min(0, "الراتب لا يمكن أن يكون سالباً").max(1_000_000_000_000, "المبلغ كبير جداً");
const key = z.string(label("مفتاح الطلب")).min(8, "مفتاح الطلب قصير").max(100);
const periodKey = z.string(label("الفترة")).regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الفترة بصيغة YYYY-MM (مثل 2026-10)");
const reason = str("السبب", 300);
const method = z.enum(["cash", "other"], { errorMap: () => ({ message: "طريقة الدفع: cash أو other" }) });
const entryParams = z.object({ id: objectId("المعرّف"), entryId: objectId("القيد") });

const employeeBody = {
  name: str("الاسم", 120), jobTitle: optStr(80), phone: optStr(40), hireDate: isoDate.optional(), status: z.enum(EMPLOYEE_STATUSES).optional(),
  userId: objectId("حساب الدخول").optional(), salary, currency, payDay: z.number().int().min(1).max(28).optional(), notes: optStr(500),
  salaryEffectiveFrom: periodKey.optional(),
};
const empList = { query: z.object({ q: z.string().max(80).optional(), status: z.enum(EMPLOYEE_STATUSES).optional(), periodKey: periodKey.optional(), ...paging }) };
const empCreate = { body: z.object(employeeBody).strict() };
const empUpdate = {
  params: idParam,
  body: z.object({ ...employeeBody, name: employeeBody.name.optional(), salary: salary.optional(), currency: currency.optional(), userId: objectId("حساب الدخول").nullable().optional(), hireDate: isoDate.nullable().optional() }).strict()
    .refine((b) => Object.keys(b).length > 0, "لا توجد حقول للتعديل"),
};
const empGet = { params: idParam };
const empAccount = { params: idParam, query: z.object({ period: periodKey.optional() }) };
const empPeriods = { params: idParam, query: z.object({ status: z.enum(PAYROLL_STATUSES).optional(), ...paging }) };
const empLedger = {
  params: idParam,
  query: z.object({ type: z.enum(PAYROLL_LEDGER_TYPES).optional(), period: objectId("الفترة").optional(), periodKey: periodKey.optional(), from: isoDate.optional(), to: isoDate.optional(), state: z.enum(["posted", "reversed", "reversal"]).optional(), ...paging }),
};

const periodCreate = { body: z.object({ employeeId: objectId("الموظف"), periodKey, currency: currency.optional(), idempotencyKey: key.optional() }).strict() };
const periodGet = { params: idParam };
const periodAdjust = { params: idParam, body: z.object({ kind: z.enum(["allowance", "bonus", "deduction"]), amount, currency: currency.optional(), note: str("البيان", 300), date: isoDate.optional(), idempotencyKey: key }).strict() };
const periodPay = { params: idParam, body: z.object({ amount, currency: currency.optional(), method: method.optional(), note: optStr(300), date: isoDate.optional(), idempotencyKey: key }).strict() };
const periodAction = { params: idParam, body: z.object({}).strict() };
const entryReverse = { params: entryParams, body: z.object({ reason }).strict() };

const summaryQ = { params: idParam, query: z.object({ period: periodKey.optional() }) };
const empAdjust = { params: idParam, body: z.object({ kind: z.enum(["allowance", "bonus", "deduction"]), amount, currency: currency.optional(), note: str("البيان", 300), date: isoDate.optional(), periodKey: periodKey.optional(), idempotencyKey: key }).strict() };
const empPeriodAction = { params: idParam, body: z.object({ periodKey: periodKey.optional() }).strict() };
const empClose = { params: idParam, body: z.object({ periodKey }).strict() };
const advIssue = {
  body: z.object({ employeeId: objectId("الموظف"), amount, currency: currency.optional(), method: method.optional(), deductionPeriodKey: periodKey.optional(), deductionPeriodId: objectId("فترة الخصم").optional(), note: optStr(300), date: isoDate.optional(), idempotencyKey: key }).strict(),
};
const advList = { query: z.object({ employeeId: objectId("الموظف").optional(), status: z.enum(ADVANCE_STATUSES).optional(), periodId: objectId("الفترة").optional(), ...paging }) };
const advCreate = {
  body: z.object({ employeeId: objectId("الموظف"), amount, currency: currency.optional(), deductionPeriodId: objectId("فترة الخصم"), note: optStr(300), date: isoDate.optional(), idempotencyKey: key }).strict(),
};
const advGet = { params: idParam };
const advDisburse = { params: idParam, body: z.object({ method: method.optional(), note: optStr(300), date: isoDate.optional() }).strict() };
const advSettle = { params: idParam, body: z.object({ amount, currency: currency.optional(), note: optStr(300), date: isoDate.optional(), idempotencyKey: key }).strict() };
const advReverse = { params: idParam, body: z.object({ reason }).strict() };
const advReassign = { params: idParam, body: z.object({ periodId: objectId("فترة الخصم"), reason, idempotencyKey: key }).strict() };

module.exports = {
  summaryQ, empAdjust, empPeriodAction, empClose, advIssue, empList, empCreate, empUpdate, empGet, empAccount, empPeriods, empLedger, periodCreate, periodGet, periodAdjust, periodPay, periodAction, entryReverse,
  advList, advCreate, advGet, advDisburse, advSettle, advReverse, advReassign, entryParams,
};
