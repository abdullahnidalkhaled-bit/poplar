const mongoose = require("mongoose");
const env = require("./config/env");
const logger = require("./utils/logger");
const { connectDB } = require("./config/db");
const { createApp } = require("./app");

async function main() {
  await connectDB();
  const app = createApp();
  const server = app.listen(env.port, () => logger.info({ port: env.port, env: env.nodeEnv }, "server listening"));

  // إيقاف نظيف: إنهاء الطلبات الجارية ثم إغلاق الاتصال
  const shutdown = (signal) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
