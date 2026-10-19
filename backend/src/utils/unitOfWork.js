const mongoose = require("mongoose");
const env = require("../config/env");
const logger = require("./logger");

let txSupported; // تُحسب مرة واحدة

// المعاملات (Transactions) تحتاج Replica Set (MongoDB محلي مضبوط كـ rs0)
const supportsTransactions = () => {
  if (env.disableTransactions) return false;
  if (txSupported !== undefined) return txSupported;
  const type = mongoose.connection.getClient?.()?.topology?.description?.type;
  txSupported = ["ReplicaSetWithPrimary", "Sharded", "LoadBalanced"].includes(type);
  logger.info({ transactions: txSupported, topology: type }, "transaction support detected");
  return txSupported;
};

/**
 * ينفّذ عملية متعددة الخطوات كوحدة واحدة: إما تنجح كلها أو لا شيء.
 *  - مع Replica Set: Transaction حقيقية (ctx.session).
 *  - بدونها: كل خطوة ذرّية بذاتها، وتُسجَّل دالة تراجع عبر ctx.undo(fn) وتُنفَّذ بترتيب عكسي عند الفشل.
 * الكود المستدعي يكتب مساراً واحداً ويدعم الحالتين.
 */
async function runAtomic(work) {
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work({ session, undo: () => {} });
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  const undos = [];
  const ctx = { session: null, undo: (fn) => undos.push(fn) };
  try {
    return await work(ctx);
  } catch (err) {
    for (const fn of undos.reverse()) {
      try {
        await fn();
      } catch (undoErr) {
        logger.error({ err: undoErr }, "rollback step failed");
      }
    }
    throw err;
  }
}

const sessionOpts = (ctx) => (ctx && ctx.session ? { session: ctx.session } : {});

module.exports = { runAtomic, sessionOpts, supportsTransactions };
