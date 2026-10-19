const employeeRepo = require("../repositories/employee.repository");
const payrollRepo = require("../repositories/payroll.repository");
const advanceRepo = require("../repositories/employeeAdvance.repository");
const userRepo = require("../repositories/user.repository");
const { nextSeq } = require("../repositories/counter.repository");
const { toMinorC, validAmount, fromMinorC } = require("../utils/money");
const { parsePaging, pageResult } = require("../utils/pagination");
const { normalizeText, escapeRegex } = require("../utils/text");
const { advanceOutstanding, indicator } = require("../utils/payroll");
const { badRequest, notFound, conflict } = require("../utils/errors");
const { presentEmployee, presentPeriod, presentAdvance } = require("./payroll.present");
const { runAtomic } = require("../utils/unitOfWork");
const { actorOf } = require("./employeeLedger.service");
const { buildSummary } = require("./employeeFinance.service");

const currentKey = () => new Date().toISOString().slice(0, 7);
const checkEffective = (k) => { if (k && k > currentKey()) throw badRequest("شهر سريان الراتب لا يكون في المستقبل.", "INVALID_EFFECTIVE_MONTH"); };

async function assertUserLink(userId, exceptEmployeeId) {
  if (!userId) return;
  const user = await userRepo.findById(userId);
  if (!user) throw badRequest("حساب الدخول المرتبط غير موجود.", "USER_NOT_FOUND");
  if (user.role === "admin") throw badRequest("لا يُربط موظف بحساب المالك.", "USER_IS_OWNER");
  const taken = await employeeRepo.findByUser(userId);
  if (taken && String(taken._id) !== String(exceptEmployeeId || "")) throw conflict("هذا الحساب مرتبط بموظف آخر.", "USER_ALREADY_LINKED");
}

const checkSalary = (currency, salary) => {
  if (!validAmount(currency, salary)) throw badRequest(currency === "SYP" ? "راتب الليرة عدد صحيح." : "راتب الدولار بخانتين عشريتين كحد أقصى.", "INVALID_AMOUNT_PRECISION");
};

async function create(body, actor) {
  checkSalary(body.currency, body.salary);
  checkEffective(body.salaryEffectiveFrom);
  await assertUserLink(body.userId);
  try {
    const e = await runAtomic(async (ctx) => {
      const doc = await employeeRepo.create(
        {
          number: `EMP-${String(await nextSeq("employee", ctx)).padStart(6, "0")}`, name: body.name, nameKey: normalizeText(body.name), jobTitle: body.jobTitle || "",
          phone: body.phone || "", hireDate: body.hireDate ? new Date(body.hireDate) : undefined, status: body.status || "active", user: body.userId || undefined, salaryEffectiveFrom: body.salaryEffectiveFrom,
          salaryMinor: toMinorC(body.currency, body.salary), currency: body.currency, payDay: body.payDay || 1, notes: body.notes || "", createdBy: actorOf(actor),
        },
        ctx
      );
      ctx.undo(() => employeeRepo.deleteById(doc._id));
      return doc;
    });
    return presentEmployee(e);
  } catch (err) {
    if (err.code === 11000) throw conflict("هذا الحساب مرتبط بموظف آخر.", "USER_ALREADY_LINKED");
    throw err;
  }
}

async function update(id, body, actor) {
  const e = await employeeRepo.findById(id);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  const patch = { updatedBy: actorOf(actor) };
  if (body.currency && body.currency !== e.currency) {
    if ((await payrollRepo.hasAny(e._id)) || (await advanceRepo.hasAny(e._id))) throw conflict("لا تُغيَّر عملة موظف لديه فترات رواتب أو سلف.", "CURRENCY_LOCKED");
    patch.currency = body.currency;
  }
  const cur = patch.currency || e.currency;
  if (body.salary !== undefined) {
    checkSalary(cur, body.salary);
    patch.salaryMinor = toMinorC(cur, body.salary);
    // تغيير الراتب الفعلي يبدأ سريانه من الشهر الحالي (ما لم يُصرَّح بغيره)؛ الفترات القائمة تحتفظ بلقطتها
    if (patch.salaryMinor !== e.salaryMinor && body.salaryEffectiveFrom === undefined) patch.salaryEffectiveFrom = currentKey();
  }
  if (body.salaryEffectiveFrom !== undefined) { checkEffective(body.salaryEffectiveFrom); patch.salaryEffectiveFrom = body.salaryEffectiveFrom; }
  else if (patch.currency) throw badRequest("أرسل الراتب مع تغيير العملة.", "SALARY_REQUIRED");
  if (body.name !== undefined) { patch.name = body.name; patch.nameKey = normalizeText(body.name); }
  for (const f of ["jobTitle", "phone", "notes", "status", "payDay"]) if (body[f] !== undefined) patch[f] = body[f];
  if (body.hireDate !== undefined) patch.hireDate = body.hireDate ? new Date(body.hireDate) : undefined;
  if (body.userId !== undefined) { await assertUserLink(body.userId, e._id); patch.user = body.userId || undefined; }
  try {
    return presentEmployee(await employeeRepo.update(id, patch));
  } catch (err) {
    if (err.code === 11000) throw conflict("هذا الحساب مرتبط بموظف آخر.", "USER_ALREADY_LINKED");
    throw err;
  }
}

async function get(id) {
  const e = await employeeRepo.findById(id);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  return presentEmployee(e);
}

/**
 * قائمة الحسابات: استعلامات مجمَّعة (موظفون ← فتراتهم ← سلفهم) ثم buildSummary نفسها التي يستعملها حساب الموظف،
 * فلا تختلف الأرقام بين القائمة والحساب. بلا periodKey يُحدَّد لكل موظف شهره الافتراضي (أقدم شهر عليه متبقٍ وإلا الحالي).
 */
async function list(q) {
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.q) {
    const t = q.q.trim();
    filter.$or = [{ nameKey: { $regex: escapeRegex(normalizeText(t)) } }, { number: { $regex: escapeRegex(t.toUpperCase()) } }];
  }
  const paging = parsePaging(q, 20);
  const { items, total } = await employeeRepo.list(filter, paging);
  const ids = items.map((e) => e._id);
  const [periods, advs] = ids.length ? await Promise.all([payrollRepo.byEmployees(ids), advanceRepo.byEmployees(ids)]) : [[], []];
  const pBy = new Map();
  const aBy = new Map();
  for (const p of periods) (pBy.get(String(p.employee)) || pBy.set(String(p.employee), []).get(String(p.employee))).push(p);
  for (const a of advs) (aBy.get(String(a.employee)) || aBy.set(String(a.employee), []).get(String(a.employee))).push(a);
  const now = new Date();
  const rows = items.map((e) => {
    const { summary: s, period } = buildSummary(e, pBy.get(String(e._id)) || [], aBy.get(String(e._id)) || [], q.periodKey, now);
    return {
      ...presentEmployee(e), periodKey: s.periodKey, period, status: e.status, periodStatus: s.status, indicator: s.indicator,
      due: { net: s.entitlement, paid: s.paid, settlementsApplied: s.settlementsApplied, scheduledSettlement: s.scheduledSettlement, remainingBeforeSettlement: s.remainingBeforeSettlement, remaining: s.remainingPayable },
      canPay: s.canPay, reason: s.reason, advancesOutstanding: s.advances.outstanding, advancesOutstandingCount: s.advances.outstandingCount, nextDueDate: s.nextDueDate,
    };
  });
  return { ...pageResult(rows, total, paging), periodKey: q.periodKey || null, currentKey: currentKey() };
}

/** الحساب الكامل لموظف: الملف + كل فتراته + فترة محددة + سلفها + السلف القائمة (كلها من الخادم) */
async function account(id, periodKey) {
  const e = await employeeRepo.findById(id);
  if (!e) throw notFound("الموظف غير موجود.", "EMPLOYEE_NOT_FOUND");
  const [periods, advances] = await Promise.all([payrollRepo.byEmployee(e._id), advanceRepo.byEmployee(e._id)]);
  const keys = Object.fromEntries(periods.map((p) => [String(p._id), p.periodKey]));
  const now = new Date();
  const selected = periods.find((p) => p.periodKey === (periodKey || currentKey())) || (periodKey ? null : periods[0]) || null;
  const sel = selected ? String(selected._id) : null;
  const open = advances.filter((a) => advanceRepo.OPEN.includes(a.status));
  return {
    employee: presentEmployee(e),
    periods: periods.map((p) => presentPeriod(p, now)),
    selectedPeriodKey: selected?.periodKey || periodKey || currentKey(),
    period: selected ? presentPeriod(selected, now) : null,
    periodAdvances: advances.filter((a) => String(a.deductionPeriod) === sel).map((a) => presentAdvance(a, keys)),
    outstandingAdvances: open.map((a) => presentAdvance(a, keys)),
    totals: { advancesOutstanding: fromMinorC(e.currency, open.filter((a) => a.status !== "pending").reduce((n, a) => n + advanceOutstanding(a), 0)), advancesPending: fromMinorC(e.currency, open.filter((a) => a.status === "pending").reduce((n, a) => n + a.amountMinor, 0)), currency: e.currency },
  };
}

module.exports = { create, update, get, list, account, currentKey };
