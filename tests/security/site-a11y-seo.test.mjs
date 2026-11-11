import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const robots = readFileSync(new URL("../../robots.txt", import.meta.url), "utf8");
const sitemap = readFileSync(new URL("../../sitemap.xml", import.meta.url), "utf8");

test("the homepage has one semantic H1 and a continuous heading hierarchy", () => {
  assert.equal((frontend.match(/<h1\b/gi) || []).length, 1);
  assert.doesNotMatch(frontend, /<h[56]\b/i);
  assert.ok(frontend.includes('<h1 class="hero-script">Найди'));
});

test("interactive controls have a visible keyboard focus treatment and honor reduced motion", () => {
  assert.ok(frontend.includes(":focus-visible"));
  assert.ok(frontend.includes("@media (prefers-reduced-motion: reduce)"));
});

test("banner image fallback does not use inline event attributes", () => {
  assert.doesNotMatch(frontend, /\sonerror\s*=/i);
  assert.ok(frontend.includes('querySelectorAll(".hero-img img")'));
  assert.ok(frontend.includes('addEventListener("error"'));
});

test("Supabase SDK is pinned to the tested stable release and external font dependency is removed", () => {
  assert.ok(frontend.includes("@supabase/supabase-js@2.119.0"));
  assert.ok(!frontend.includes("fonts.googleapis.com"));
});

test("social previews and crawler metadata are complete for the public homepage", () => {
  assert.ok(frontend.includes('name="robots" content="index,follow'));
  assert.ok(frontend.includes('name="theme-color"'));
  assert.ok(frontend.includes('property="og:locale" content="ru_RU"'));
  assert.ok(frontend.includes('name="twitter:image"'));
  assert.ok(frontend.includes('rel="canonical"'));
  assert.ok(robots.includes("Sitemap: https://spartakdubov059.github.io/fam-website/sitemap.xml"));
  assert.ok(sitemap.includes("<loc>https://spartakdubov059.github.io/fam-website/</loc>"));
});

test("the photo form does not claim moderation is disabled", () => {
  assert.ok(!frontend.includes("Автоматическая проверка содержимого фото пока не выполняется"));
  assert.ok(frontend.includes("Фото проходит проверку FAM"));
  assert.ok(frontend.includes("не считается одобренной"));
});
