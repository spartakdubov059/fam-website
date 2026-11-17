import test from "node:test";
import assert from "node:assert/strict";
import price from "../../price-format.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "index.html"), "utf8");

test("numeric listing prices are always formatted in Russian rubles", () => {
  assert.equal(price.formatListingPrice("1500"), "1 500 ₽");
  assert.equal(price.formatListingPrice("1 500"), "1 500 ₽");
  assert.equal(price.formatListingPrice("1500 ₽"), "1 500 ₽");
  assert.equal(price.formatListingPrice("2500,50"), "2 500,5 ₽");
});

test("free and negotiable listing prices remain readable text", () => {
  assert.equal(price.formatListingPrice("Бесплатно"), "Бесплатно");
  assert.equal(price.formatListingPrice("Договорная"), "Договорная");
  assert.equal(price.formatListingPrice("По договорённости"), "По договорённости");
  assert.equal(price.formatListingPrice(""), "Бесплатно");
});

test("the listing form previews rubles and all listing views use the same formatter", () => {
  assert.match(html, /Цена в рублях/);
  assert.match(html, /id="pricePreview"/);
  assert.match(html, /FAMPrice\.formatListingPrice\(\$\("lPrice"\)\.value\)/);
  assert.match(html, /FAMPrice\.formatListingPrice\(l\.price_text \|\| "Бесплатно"\)/);
  assert.match(html, /FAMPrice\.formatListingPrice\(listing\.price_text \|\| "Бесплатно"\)/);
});
