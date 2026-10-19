const { presentModel } = require("./model.presenter");

// قائمة موديلات مرقّمة أو نتائج بحث: كل عنصر يُعرض كموديل (ويحتفظ بـ matchType إن وُجد)
function present(payload) {
  return {
    ...payload,
    items: payload.items.map((item) => {
      const { matchType, ...doc } = item;
      return { ...(matchType ? { matchType } : {}), ...presentModel(doc) };
    }),
  };
}

module.exports = { name: "modelList", present };
