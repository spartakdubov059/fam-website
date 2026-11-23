import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const submit = readFileSync(new URL("../../supabase/functions/submit-content/index.ts", import.meta.url), "utf8");
const moderate = readFileSync(new URL("../../supabase/functions/moderate/index.ts", import.meta.url), "utf8");
const netlify = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
const healthMarker = readFileSync(new URL("../../fam-domain-health.json", import.meta.url), "utf8");
const sdkFallback = readFileSync(new URL("../../supabase-cdn-fallback.js", import.meta.url), "utf8");

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

test("GitHub Pages redirects only after the exact primary readiness marker confirms health", () => {
  const head = html.slice(0, html.indexOf("<meta charset="));
  assert.ok(head.includes("<head>"));
  assert.ok(head.includes('window.location.hostname !== "spartakdubov059.github.io"'));
  assert.ok(head.includes('https://famru.netlify.app/fam-domain-health.json?t='));
  assert.ok(head.includes('mode: "cors"'));
  assert.ok(head.includes('cache: "no-store"'));
  assert.ok(head.includes('health && health.site === "famru" && health.ok === true'));
  assert.ok(head.includes('window.location.replace(target)'));
  assert.ok(head.includes("}, 4000);"));
  assert.ok(head.includes("stay on GitHub Pages"));
  assert.ok(!head.includes("probePrimaryAsset()"));
  assert.ok(!head.includes("banner-1.webp?probe="));
  assert.ok(head.includes("stay on GitHub Pages"));
  assert.ok(head.includes("window.location.search + window.location.hash"));
});

test("Supabase HTTP 401 confirms the API answered but does not claim login was tested", async () => {
  const { summarizeNodeResult, TARGETS } = await import("../../scripts/check-fam-russia-reachability.mjs");
  const result = summarizeNodeResult([[1, "42ms", "Unauthorized", "401"]]);
  assert.equal(result.state, "auth-required");
  assert.equal(result.status, "401");
  assert.match(result.info, /дошёл до API/);
  assert.ok(TARGETS.some(target => target.name === "FAM GitHub Pages readiness marker" &&
    target.url === "https://spartakdubov059.github.io/fam-website/fam-domain-health.json"));
});

test("Netlify health marker is uncached and allows only the GitHub Pages fallback origin", () => {
  assert.ok(healthMarker.includes('"site":"famru"'));
  assert.ok(netlify.includes('Access-Control-Allow-Origin = "https://spartakdubov059.github.io"'));
  assert.ok(netlify.includes('Cache-Control = "no-store"'));
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
  assert.match(html, /<script src="\.\/supabase-cdn-fallback\.js"><\/script>/);
  assert.match(html, /<script id="famSupabaseSdk" src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.119\.0" integrity="sha384-[^"]+" crossorigin="anonymous"><\/script>/);
  assert.ok(sdkFallback.includes("document.write("));
  assert.ok(sdkFallback.includes("https://unpkg.com/@supabase/supabase-js@2.119.0"));
  assert.match(sdkFallback, /integrity="sha384-[^"]+" crossorigin="anonymous"/);
  assert.ok(sdkFallback.includes("Не удалось загрузить модуль FAM"));
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
