const mongoose = require("mongoose");
const env = require("./env");
const logger = require("../utils/logger");

async function connectDB() {
  env.assertValid();
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
  logger.info("MongoDB connected");
}

module.exports = { connectDB };
