const pino = require("pino");
const env = require("../config/env");

// تسجيل منظّم (JSON). كلمات المرور والرؤوس الحساسة لا تُطبع أبداً
module.exports = pino({
  level: env.logLevel,
  redact: ["req.headers.authorization", "req.headers.cookie", "mongoUri"],
});
