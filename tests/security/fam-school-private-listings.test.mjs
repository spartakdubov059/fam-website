import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261121190000_restrict_listings_to_authenticated_same_school.sql", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("school listings are restricted to signed-in members of the same school", () => {
  assert.match(migration, /alter policy "Read active listings or own listings"/i);
  assert.match(migration, /to authenticated\s+using\s*\(/i);
  assert.match(migration, /viewer\.id\s*=\s*\(select auth\.uid\(\)\)/i);
  assert.match(migration, /viewer\.school_id\s*=\s*listings\.school_id/i);
  assert.match(migration, /status\s*=\s*'active'/i);
  assert.match(migration, /user_id\s*=\s*\(select auth\.uid\(\)\)/i);
  assert.doesNotMatch(migration, /to\s+anon\s*,\s*authenticated/i);
});

test("guest visitors see a login prompt rather than an empty broken-looking board", () => {
  const code = html.slice(html.indexOf("function renderListings()"), html.indexOf("function renderFavorites()"));
  assert.match(code, /if\s*\(!user\)\s*\{/);
  assert.match(code, /Войдите, чтобы смотреть объявления/i);
  assert.match(code, /data-action="open-auth"/);
});

test("listing text renders independently of photo signing and overlapping refreshes are coalesced", () => {
  const loadAll = html.slice(html.indexOf("async function loadAll()"), html.indexOf("const getTaken"));
  assert.doesNotMatch(loadAll, /await\s+hydrateListingImages\(/);
  assert.match(loadAll, /void\s+hydrateListingImages\(rowsToHydrate\)/);
  assert.match(loadAll, /\.catch\(\(\)\s*=>\s*\{\s*reportFamSiteError\("database_request_failed",\s*"database"\)/);

  const helper = html.slice(html.indexOf("function hydrateListingImages(rows)"), html.indexOf("function renderIdeaImages"));
  assert.match(helper, /listingImageHydrationInFlight/);
  assert.match(helper, /listingImageHydrationQueuedRows\s*=\s*rows/);
  assert.match(helper, /hydrateListingImagesBatch\(rowsToHydrate\)/);
});
