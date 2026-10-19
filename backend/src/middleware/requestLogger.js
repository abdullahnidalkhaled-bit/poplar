const crypto = require("crypto");
const logger = require("../utils/logger");

// سجل منظّم لكل طلب: المسار والحالة والمدة ومعرّف التتبع (بلا أجسام الطلبات حمايةً للبيانات)
module.exports = (req, res, next) => {
  const id = crypto.randomUUID();
  const start = process.hrtime.bigint();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info({ id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, "request");
  });
  next();
};
