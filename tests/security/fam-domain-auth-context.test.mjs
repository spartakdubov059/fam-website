import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const head = html.slice(0, html.indexOf("<meta charset="));

test("startup does not probe or force navigation to the paused secondary publisher", () => {
  assert.doesNotMatch(head, /<script\b/i);
  assert.doesNotMatch(html, /window\.location\.replace\(target\)/);
  assert.doesNotMatch(html, /fam-domain-health\.json\?t=/);
  assert.match(html, /rel="canonical" href="https:\/\/spartakdubov059\.github\.io\/fam-website\//);
});

test("sign-in and email callbacks stay on their own trusted origin", () => {
  const match = html.match(/function famSignupRedirectUrl\(\) \{[\s\S]*?\n  \}/);
  assert.ok(match);
  const signup = (origin, pathname) => new Function("window", match[0] + "\nreturn famSignupRedirectUrl();")({location:{origin,pathname}});
  assert.equal(signup("https://spartakdubov059.github.io", "/fam-website/"), "https://spartakdubov059.github.io/fam-website/");
  assert.equal(signup("https://famru.netlify.app", "/"), "https://famru.netlify.app/");
});
