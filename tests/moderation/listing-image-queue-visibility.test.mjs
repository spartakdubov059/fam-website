import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = await readFile(resolve(root, "index.html"), "utf8");
const migration = await readFile(
  resolve(root, "supabase/migrations/20261110210025_add_persistent_listing_image_review_queue.sql"),
  "utf8",
);

test("pending and hidden listings are only loaded alongside active listings for their owner", () => {
  assert.match(html, /\.or\("status\.eq\.active,user_id\.eq\." \+ user\.id\)/);
  assert.match(html, /l\.status === "active"/);
  assert.match(html, /l\.status === "active" && isFavorite/);
});

test("queued listings start hidden and keep their image URL private", () => {
  assert.match(migration, /null, 'hidden', 'pending'/);
  assert.match(migration, /status = 'active', moderation_status = 'approved', image_url = p_image_url/);
  assert.match(migration, /status = 'hidden', moderation_status = 'rejected', image_url = null/);
});

test("only service_role can execute the moderation queue RPCs", () => {
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
  assert.match(migration, /private\.listing_image_moderation_queue/);
});
