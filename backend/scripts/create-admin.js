/*
 * إنشاء حساب المالك (admin) من الخادم فقط. لا يوجد مسار API لذلك.
 *
 *   npm run create-admin                      إنشاء أول مالك (يسأل تفاعلياً، أو من ADMIN_USERNAME / ADMIN_NAME / ADMIN_PASSWORD)
 *   npm run create-admin -- --additional      السماح بمالك إضافي حين يوجد مالك فعلاً
 *   npm run create-admin -- --reset           تغيير كلمة مرور مالك موجود (استرجاع الوصول) وإسقاط كل جلساته
 *
 * لا يطبع كلمة المرور ولا يسجّلها. يرفض الكتابة فوق حساب موجود دون --reset.
 */
const readline = require("readline");
const mongoose = require("mongoose");
const env = require("../src/config/env");
const User = require("../src/models/user.model");
const Session = require("../src/models/session.model");
const { hashPassword, passwordProblem } = require("../src/utils/password");

const args = new Set(process.argv.slice(2));

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write(""); };
    }
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  if (!env.mongoUri) throw new Error("MONGO_URI مفقود في .env");
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
  await User.init();

  const username = (process.env.ADMIN_USERNAME || (await ask("اسم المستخدم (إنجليزي): "))).trim().toLowerCase();
  if (!/^[a-z0-9._@+-]{3,64}$/.test(username)) throw new Error("اسم المستخدم غير صالح (3-64 خانة: أحرف إنجليزية صغيرة وأرقام و . _ - @).");

  const existing = await User.findOne({ username });
  const adminCount = await User.countDocuments({ role: "admin" });

  if (args.has("--reset")) {
    if (!existing || existing.role !== "admin") throw new Error("لا يوجد مالك بهذا الاسم لإعادة ضبط كلمة مروره.");
  } else {
    if (existing) throw new Error("الحساب موجود مسبقاً. لإعادة ضبط كلمة مروره استعمل --reset.");
    if (adminCount > 0 && !args.has("--additional")) throw new Error("يوجد مالك فعلاً. لإضافة مالك آخر استعمل --additional عن قصد.");
  }

  const name = args.has("--reset") ? existing.name : (process.env.ADMIN_NAME || (await ask("الاسم الظاهر: "))).trim();
  if (!name) throw new Error("الاسم مطلوب.");

  const password = process.env.ADMIN_PASSWORD || (await ask("كلمة المرور: ", { hidden: true }));
  if (!process.env.ADMIN_PASSWORD && password !== (await ask("أعد كتابة كلمة المرور: ", { hidden: true }))) throw new Error("كلمتا المرور غير متطابقتين.");
  const problem = passwordProblem(password, username);
  if (problem) throw new Error(problem);

  const passwordHash = await hashPassword(password);
  if (args.has("--reset")) {
    await User.updateOne({ _id: existing._id }, { $set: { passwordHash, active: true }, $inc: { tokenVersion: 1 } });
    await Session.deleteMany({ user: existing._id });
    console.log(`تمت إعادة ضبط كلمة مرور المالك "${username}" وأُسقطت كل جلساته.`);
  } else {
    await User.create({ name, username, passwordHash, role: "admin", active: true });
    console.log(`تم إنشاء المالك "${username}". سجّل الدخول من الواجهة.`);
  }
}

main()
  .catch((err) => { console.error("فشل:", err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
