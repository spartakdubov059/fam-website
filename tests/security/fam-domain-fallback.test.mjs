import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const submit = readFileSync(new URL("../../supabase/functions/submit-content/index.ts", import.meta.url), "utf8");
const moderate = readFileSync(new URL("../../supabase/functions/moderate/index.ts", import.meta.url), "utf8");

const fallbackOrigin = "https://spartakdubov059.github.io";
const primaryOrigin = "https://famru.netlify.app";
const fallbackUrl = fallbackOrigin + "/fam-website/";
const primaryUrl = primaryOrigin + "/";

function signupRedirect(origin, pathname) {
  const match = html.match(/function famSignupRedirectUrl\(\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "signup redirect helper must be present");
  return new Function("window", match[0] + "\nreturn famSignupRedirectUrl();")({
    location: { origin, pathname },
  });
}

test("GitHub Pages is independent, never forcibly redirected to Netlify", () => {
  const head = html.slice(0, html.indexOf("<meta charset="));
  assert.ok(head.includes("<head>"));
  assert.doesNotMatch(head, /location\.(?:replace|assign)|window\.location|http-equiv=["']refresh/);
  assert.doesNotMatch(head, /<script/);
});

test("signup confirmation on GitHub Pages remains on that same fallback host", () => {
  assert.equal(signupRedirect(fallbackOrigin, "/fam-website/"), fallbackUrl);
  assert.equal(signupRedirect(fallbackOrigin, "/fam-website"), fallbackUrl);
  assert.equal(signupRedirect(fallbackOrigin, "/fam-website/index.html"), fallbackUrl);
  assert.equal(signupRedirect(primaryOrigin, "/"), primaryUrl);
  // Never trust an arbitrary origin for email-redirect links.
  assert.equal(signupRedirect("https://unknown.example", "/"), primaryUrl);
  assert.equal(signupRedirect(fallbackOrigin, "/unrelated-site"), primaryUrl);
  assert.match(html, /emailRedirectTo:\s*famSignupRedirectUrl\(\)/);
});

test("both frontend entry points have working relative assets", () => {
  assert.match(html, /<script src="price-format\.js"><\/script>/);
  assert.match(html, /<script src="\.\/school-pulse\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/school-pulse\.css">/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.119\.0/);
});

test("existing server-side CORS allows both real FAM hosts", () => {
  for (const source of [submit, moderate]) {
    assert.ok(source.includes(JSON.stringify(fallbackOrigin)));
    assert.ok(source.includes(JSON.stringify(primaryOrigin)));
  }
});

test("SEO canonical remains the primary host; fallback is not treated as another site", () => {
  assert.ok(html.includes('rel="canonical" href="https://famru.netlify.app/"'));
  assert.ok(html.includes('property="og:url" content="https://famru.netlify.app/"'));
});
