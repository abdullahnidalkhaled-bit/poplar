const Counter = require("../models/counter.model");
const { sessionOpts } = require("../utils/unitOfWork");

// الرقم التالي بشكل ذرّي (آمن مع الطلبات المتزامنة)
const nextSeq = async (name, ctx) => {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after", ...sessionOpts(ctx) });
  return doc.seq;
};

// الرقم الحالي دون استهلاكه (للاقتراحات فقط)
const peekSeq = async (name) => (await Counter.findById(name))?.seq || 0;

module.exports = { nextSeq, peekSeq };
