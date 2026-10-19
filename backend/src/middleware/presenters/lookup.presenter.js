const { presentModel } = require("./model.presenter");

// نتيجة تحليل رمز: { kind: "model" | "size", model, size? } — المقاس يُعاد بحالته المشتقة من الموديل المعروض
function present(payload) {
  const model = presentModel(payload.model);
  if (payload.kind !== "size") return { ...payload, model };
  return { ...payload, model, size: model.sizes.find((s) => s.barcode === payload.size.barcode) };
}

module.exports = { name: "lookup", present };
