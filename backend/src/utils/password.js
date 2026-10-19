const crypto = require("crypto");

// scrypt: دالة اشتقاق مستهلكة للذاكرة ومضمّنة في Node (بلا اعتماديات أصلية). الصيغة: scrypt$N$r$p$salt$hash
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;

const derive = (password, salt, n, r, p) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  );

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// عند غياب الحساب نُنفّذ نفس الكلفة كي لا يُكشف وجود الحسابات من زمن الاستجابة
let dummy;
async function verifyDummy(password) {
  dummy = dummy || (await hashPassword("dummy-password-for-timing"));
  await verifyPassword(password, dummy);
  return false;
}

// سياسة كلمة المرور: 10 خانات على الأقل، حروف وأرقام، ولا تحوي اسم المستخدم
function passwordProblem(password, username = "") {
  if (typeof password !== "string" || password.length < 10) return "كلمة المرور يجب ألا تقل عن 10 خانات.";
  if (password.length > 128) return "كلمة المرور طويلة جداً.";
  if (!/[A-Za-z؀-ۿ]/.test(password) || !/\d/.test(password)) return "كلمة المرور يجب أن تحوي حروفاً وأرقاماً.";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "كلمة المرور لا يجوز أن تحوي اسم المستخدم.";
  return null;
}

module.exports = { hashPassword, verifyPassword, verifyDummy, passwordProblem };
