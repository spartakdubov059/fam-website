import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");

test("Netlify applies baseline browser security headers site-wide", () => {
  assert.match(config, /for\s*=\s*"\/\*"/);
  assert.match(config, /X-Content-Type-Options\s*=\s*"nosniff"/);
  assert.match(config, /Referrer-Policy\s*=\s*"strict-origin-when-cross-origin"/);
  assert.match(config, /X-Frame-Options\s*=\s*"DENY"/);
});
