const mongoose = require("mongoose");

// جلسات على الخادم (MongoDB). المعرّف الخام لا يُخزَّن أبداً: يُخزَّن HMAC له فقط
const sessionSchema = new mongoose.Schema({
  sidHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  csrf: { type: String, required: true },
  tokenVersion: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  // الانتهاء المطلق: يحذفه MongoDB تلقائياً عبر فهرس TTL
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  ip: String,
  userAgent: { type: String, maxlength: 200 },
});

module.exports = mongoose.model("Session", sessionSchema);
