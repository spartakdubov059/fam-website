import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

const assetUrl = (name) => new URL(`../../${name}`, import.meta.url);
const webpAssets = Array.from({ length: 6 }, (_, index) => `banner-${index + 1}.webp`);
const jpegAssets = Array.from({ length: 6 }, (_, index) => `banner-${index + 1}.jpg`);
const totalBytes = (assets) => assets.reduce((sum, name) => sum + statSync(assetUrl(name)).size, 0);

test("hero banners have compact WebP sources and JPEG fallbacks", () => {
  for (const name of webpAssets) assert.ok(statSync(assetUrl(name)).size < 300_000, `${name} exceeds the per-image budget`);
  for (const name of jpegAssets) assert.ok(statSync(assetUrl(name)).size < 350_000, `${name} exceeds the fallback budget`);
  assert.ok(totalBytes(webpAssets) < 900_000, "WebP carousel exceeds its transfer budget");
  assert.ok(totalBytes(jpegAssets) < 1_500_000, "JPEG fallbacks exceed their transfer budget");
  assert.ok(totalBytes([...webpAssets, ...jpegAssets]) < 2_250_000, "optimized carousel exceeds its combined budget");
});
