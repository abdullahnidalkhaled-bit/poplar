const path = require("path");
const fs = require("fs");
const express = require("express");
const requestLogger = require("./middleware/requestLogger");
const { securityHeaders, limiter, corsMiddleware } = require("./middleware/security");
const errorHandler = require("./middleware/errorHandler");
const responseMiddleware = require("./middleware/response.middleware");
const routes = require("./routes");

// بناء التطبيق دون تشغيل أو اتصال بقاعدة البيانات: يسهّل الاختبار
function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "100kb" }));

  app.use("/api", limiter, responseMiddleware, routes);
  app.use("/api", (req, res) => res.status(404).json({ message: "المسار غير موجود.", code: "NOT_FOUND", requestId: req.id }));

  // يخدم بناء الواجهة (frontend/dist) إن وُجد: أمر واحد لتشغيل كل شيء
  const dist = path.join(__dirname, "..", "..", "frontend", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => (req.method === "GET" ? res.sendFile(path.join(dist, "index.html")) : next()));
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
