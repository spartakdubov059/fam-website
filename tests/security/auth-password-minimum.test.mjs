import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("new account registration rejects passwords shorter than eight characters without changing sign-in", () => {
  assert.ok(frontend.includes('if (isReg && pass.length < 8)'));
  assert.ok(frontend.includes('Для нового аккаунта используйте пароль не короче 8 символов.'));
  assert.ok(frontend.includes('sb.auth.signInWithPassword({ email, password: pass })'));
});
