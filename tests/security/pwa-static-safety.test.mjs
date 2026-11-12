import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = file => readFileSync(resolve(root, file), "utf8");
const html = load("index.html");
const manifest = JSON.parse(load("manifest.webmanifest"));
const sw = load("sw.js");
test("PWA manifest uses relative, project-scoped URLs and preserves the existing dark FAM theme", () => {
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#0F1014");
  assert.ok(manifest.icons.some(icon => icon.type === "image/svg+xml"));
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /src="\.\/pwa-register\.js" defer/);
});
test("worker never caches private messages, avatars, listings or API responses", () => {
  assert.match(sw, /request\.mode === "navigate"/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /allowedPaths\.includes\(url\.pathname\)/);
  assert.doesNotMatch(sw, /cache\.addAll\(\["\.\/index\.html"/);
  const precacheMatch = sw.match(/const PUBLIC_ASSETS = (\[[^;]+\]);/);
  assert.ok(precacheMatch, "explicit public asset allowlist must exist");
  const precache = JSON.parse(precacheMatch[1]);
  assert.deepEqual(precache, ["./price-format.js", "./icons/fam-icon.svg"]);
  assert.ok(!precache.some(path => /supabase|chat|auth|listing|avatar|index\.html/i.test(path)));
});
test("registration uses HTTPS and a relative worker scope", () => {
  const registration = load("pwa-register.js");
  assert.match(registration, /window\.isSecureContext/);
  assert.match(registration, /register\("\.\/sw\.js", \{ scope: "\.\/" \}\)/);
});
