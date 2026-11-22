import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const fallback = readFileSync(new URL("../../supabase-cdn-fallback.js", import.meta.url), "utf8");

test("Netlify applies baseline browser security headers site-wide", () => {
  assert.match(config, /for\s*=\s*"\/\*"/);
  assert.match(config, /X-Content-Type-Options\s*=\s*"nosniff"/);
  assert.match(config, /Referrer-Policy\s*=\s*"strict-origin-when-cross-origin"/);
  assert.match(config, /X-Frame-Options\s*=\s*"DENY"/);
  assert.match(config, /Strict-Transport-Security\s*=\s*"max-age=31536000; includeSubDomains; preload"/);
  assert.match(config, /Permissions-Policy\s*=\s*"camera=\(\), microphone=\(\), geolocation=\(\)"/);
});

test("CSP hashes authorize every inline script and both pinned Supabase SDK copies", () => {
  const metaPolicy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
  const headerPolicy = config.match(/Content-Security-Policy\s*=\s*"([^"]+)"/i)?.[1];
  assert.ok(metaPolicy, "GitHub Pages entry point must declare a CSP");
  assert.ok(headerPolicy, "Netlify must declare a CSP response header");

  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes, body]) => !/\bsrc\s*=/.test(attributes) && body.trim())
    .map(([, , body]) => body);
  assert.ok(inlineScripts.length > 0, "expected inline FAM scripts to be protected by CSP hashes");
  for (const body of inlineScripts) {
    const hash = `sha256-${createHash("sha256").update(body).digest("base64")}`;
    assert.ok(metaPolicy.includes(`'${hash}'`), `GitHub Pages CSP is missing ${hash}`);
    assert.ok(headerPolicy.includes(`'${hash}'`), `Netlify CSP is missing ${hash}`);
  }

  const sdkIntegrity = html.match(/<script\b(?=[^>]*\bid="famSupabaseSdk")([^>]*)>/i)?.[1]
    ?.match(/\bintegrity="(sha384-[^"]+)"/i)?.[1];
  const fallbackIntegrity = fallback.match(/integrity="(sha384-[^"]+)"/i)?.[1];
  assert.ok(sdkIntegrity, "primary Supabase SDK must use SRI");
  assert.ok(fallbackIntegrity, "fallback Supabase SDK must use SRI");
  for (const hash of [sdkIntegrity, fallbackIntegrity]) {
    assert.ok(metaPolicy.includes(`'${hash}'`), `GitHub Pages CSP is missing ${hash}`);
    assert.ok(headerPolicy.includes(`'${hash}'`), `Netlify CSP is missing ${hash}`);
  }
});
