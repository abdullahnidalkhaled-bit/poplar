const ledgerRepo = require("../repositories/employeeLedger.repository");
const payrollRepo = require("../repositories/payroll.repository");
const { nextSeq } = require("../repositories/counter.repository");
const { parsePaging, pageResult } = require("../utils/pagination");
const { presentLedger } = require("./payroll.present");
const { conflict } = require("../utils/errors");

const crypto = require("crypto");
// بصمة الطلب: SHA-256 لقيم الطلب المالية الجوهرية بترتيب ثابت (لا الوصف ولا التاريخ ولا المرجع)
const fingerprint = (obj) => crypto.createHash("sha256").update(JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k] ?? null]))).digest("hex");
/** نفس المفتاح + نفس البصمة = إعادة طلب (يُعاد الأصل)؛ نفس المفتاح + بصمة مختلفة = 409. سجلات قديمة بلا بصمة تُقبل كما كانت */
function assertSameRequest(prior, hash) {
  if (prior?.requestHash && hash && prior.requestHash !== hash) throw conflict("مفتاح التكرار مستعمل مسبقاً لعملية بمعطيات مختلفة. استعمل مفتاحاً جديداً لعملية جديدة.", "IDEMPOTENCY_KEY_REUSED");
}
const actorOf = (a) => (a ? { id: a.id, name: a.name } : undefined);
const isKeyDup = (err) => err?.code === 11000 && err.keyPattern && "idempotencyKey" in err.keyPattern;
const asConflict = (err, message, code) => {
  if (err?.code === 11000 && !isKeyDup(err)) throw conflict(message, code);
  throw err;
};

/** ترحيل قيد في دفتر الموظف (للإلحاق فقط). المفتاح الفريد يمنع التكرار حتى لو تزامن طلبان */
async function postEntry(spec, ctx) {
  const { employee, period, advance, type, reverseOf, reverses, currency, amountMinor, date, note = "", key, actor, requestHash } = spec;
  const entry = await ledgerRepo.create(
    {
      ref: `EL-${String(await nextSeq("employeeLedger", ctx)).padStart(6, "0")}`, employee, period, advance, type, reverseOf, reverses, currency, amountMinor,
      date: date ? new Date(date) : new Date(), note, idempotencyKey: key, requestHash, createdBy: actorOf(actor),
    },
    ctx
  );
  ctx.undo(() => ledgerRepo.deleteById(entry._id));
  return entry;
}

/** قائمة دفتر موظف: فلاتر (نوع/فترة/تاريخ/حالة) مع ترقيم. state: posted | reversed | reversal */
async function list(employeeId, q) {
  const filter = { employee: employeeId };
  if (q.type) filter.type = q.type;
  if (q.period) filter.period = q.period;
  if (q.periodKey) {
    const p = await payrollRepo.findByEmployeeAndKey(employeeId, q.periodKey);
    filter.period = p ? p._id : null;
  }
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lt: new Date(q.to) } : {}) };
  if (q.state === "reversed") filter.reversedBy = { $exists: true };
  else if (q.state === "reversal") filter.type = "reversal";
  else if (q.state === "posted") { filter.reversedBy = { $exists: false }; filter.type = q.type || { $ne: "reversal" }; }
  const paging = parsePaging(q, 25);
  const { items, total } = await ledgerRepo.list(filter, paging);
  const periods = await payrollRepo.byEmployee(employeeId);
  const keys = Object.fromEntries(periods.map((p) => [String(p._id), p.periodKey]));
  return pageResult(items.map((l) => presentLedger(l, keys)), total, paging);
}

module.exports = { postEntry, list, isKeyDup, asConflict, actorOf, fingerprint, assertSameRequest };
