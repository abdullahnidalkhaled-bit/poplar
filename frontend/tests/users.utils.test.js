import test from "node:test";
import assert from "node:assert/strict";
import { userCreateErrors, USERNAME_RE } from "../src/usersUtils.js";

test("userCreateErrors: same client-side constraints as the previous native form attributes", () => {
  const ok = { name: "سارة", username: "sara.k", password: "Strong-Pass-1" };
  assert.deepEqual(userCreateErrors(ok), { name: "", username: "", password: "" });
  assert.match(userCreateErrors({ ...ok, name: "  " }).name, /مطلوب/);
  assert.match(userCreateErrors({ ...ok, username: "" }).username, /مطلوب/);
  assert.match(userCreateErrors({ ...ok, username: "ab" }).username, /3–64/);
  assert.match(userCreateErrors({ ...ok, username: "بسام" }).username, /إنجليزية/);
  assert.match(userCreateErrors({ ...ok, username: "a".repeat(65) }).username, /3–64/);
  assert.equal(userCreateErrors({ ...ok, username: "a_b.c@d+e-f" }).username, "");
  assert.match(userCreateErrors({ ...ok, password: "" }).password, /مطلوبة/);
  assert.match(userCreateErrors({ ...ok, password: "short" }).password, /10/);
  assert.equal(userCreateErrors({ ...ok, password: "1234567890" }).password, "");
  assert.equal(USERNAME_RE.test("Admin"), true, "الخادم يحوّله إلى أحرف صغيرة");
});
