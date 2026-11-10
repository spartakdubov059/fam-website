import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const robots = readFileSync(new URL("../../robots.txt", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../../sitemap.xml", import.meta.url), "utf8");

test("the homepage has one semantic H1 and a continuous heading hierarchy", () => {
  assert.equal((frontend.match(/<h1\\b/gi) || []).length, 1);
  assert.doesNotMatch(frontend, /<h[56]\\b/i);
  assert.match(frontend, /<h1 class="hero-script">Найди/);
});

test("interactive controls have a visible keyboard focus treatment and honor reduced motion", () => {
  assert.match(frontend, /:focus-visible/);
  assert.match(frontend, /@media \\(prefers-reduced-motion:\\s*reduce\\)/);
});

test("banner image fallback does not use inline event attributes", () => {
  assert.doesNotMatch(frontend, /\\sonerror\\s*=/i);
  assert.match(frontend, /querySelectorAll\\("\\.hero-img img"\\)/);
  assert.match(frontend, /addEventListener\\("error"/);
});

test("Supabase SDK is pinned to the tested stable release and external font dependency is removed", () => {
  assert.match(frontend, /@supabase\\/supabase-js@2\\.119\\.0/);
  assert.doesNotMatch(frontend, /fonts\\.googleapis\\.com/);
});

test("social previews and crawler metadata are complete for the public homepage", () => {
  assert.match(frontend, /name="robots" content="index,follow/);
  assert.match(frontend, /name="theme-color"/);
  assert.match(frontend, /property="og:locale" content="ru_RU"/);
  assert.match(frontend, /name="twitter:image"/);
  assert.match(frontend, /rel="canonical"/);
  assert.match(robots, /Sitemap: https:\\/\\/spartakdubov059\\.github\\.io\\/fam-website\\/sitemap\\.xml/);
  assert.match(sitemap, /<loc>https:\\/\\/spartakdubov059\\.github\\.io\\/fam-website\\/<\\/loc>/);
});

test("the photo form does not claim moderation is disabled", () => {
  assert.doesNotMatch(frontend, /Автоматическая проверка содержимого фото пока не выполняется/);
  assert.match(frontend, /Фото проходит проверку FAM/);
  assert.match(frontend, /не считается одобренной/);
});
