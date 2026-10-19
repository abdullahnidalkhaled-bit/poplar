const repo = require("../repositories/productModel.repository");
const availability = require("./availability.service");
const { normalizeModelNumber, isValidModelNumber } = require("../utils/modelNumber");
const { badRequest, notFound, conflict } = require("../utils/errors");
const { QR_PREFIX, QR_VERSION } = require("../config/constants");

// حمولة QR: "PLP1:FAF-001". لا بيانات حساسة، فقط مرجع بحث ثابت + رقم إصدار للتطوير لاحقاً
const looksLikeQr = (raw) => new RegExp(`^${QR_PREFIX}\\d+:`, "i").test(String(raw ?? "").trim());

function parsePayload(raw) {
  const text = String(raw ?? "").trim();
  const m = text.match(new RegExp(`^${QR_PREFIX}(\\d+):(.+)$`, "i"));
  if (!m) throw badRequest("رمز QR غير صالح: ليس رمزاً صادراً من هذا النظام.", "INVALID_QR");
  if (Number(m[1]) !== QR_VERSION) {
    throw badRequest("رمز QR بإصدار قديم أو غير مدعوم. أعد طباعة الملصق من صفحة الموديل.", "OBSOLETE_QR");
  }
  const modelNumber = normalizeModelNumber(m[2]);
  if (!isValidModelNumber(modelNumber)) throw badRequest("رمز QR تالف: رقم الموديل غير صالح.", "INVALID_QR");
  return { version: QR_VERSION, modelNumber };
}

/**
 * نقطة التحليل الوحيدة لأي رمز (QR، باركود مقاس، رقم موديل): يستخدمها الماسح والبحث والكاشير معاً
 * فلا يوجد منطق بحث مكرر.
 */
async function resolveQr(payload) {
  const { modelNumber } = parsePayload(payload); // يرمي INVALID_QR / OBSOLETE_QR
  const doc = await repo.findByModelNumber(modelNumber);
  if (!doc) throw notFound("رمز QR غير معروف: الموديل غير موجود أو حُذف.", "QR_NOT_FOUND");
  if (!doc.active) throw conflict("هذا الموديل مؤرشف، رمز QR لم يعد صالحاً.", "QR_OBSOLETE");
  return { kind: "model", model: await availability.hydrate(doc) };
}

async function resolveCode(raw) {
  const code = String(raw ?? "").trim();
  if (!code) throw badRequest("الرمز فارغ.", "EMPTY_CODE");
  if (looksLikeQr(code)) return resolveQr(code);

  const byBarcode = await repo.findByBarcode(code);
  if (byBarcode && byBarcode.active) {
    const model = await availability.hydrate(byBarcode);
    return { kind: "size", model, size: model.sizes.find((s) => s.barcode === code) };
  }

  const mn = normalizeModelNumber(code);
  if (isValidModelNumber(mn)) {
    const doc = await repo.findByModelNumber(mn);
    if (doc && doc.active) return { kind: "model", model: await availability.hydrate(doc) };
  }
  throw notFound("لا يوجد منتج بهذا الرمز.", "CODE_NOT_FOUND");
}

module.exports = { resolveCode, resolveQr, looksLikeQr, parsePayload };
