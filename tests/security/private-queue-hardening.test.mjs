import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261111220000_harden_private_queue_and_index_user.sql", import.meta.url),
  "utf8",
);

test("private operational tables explicitly deny browser roles", () => {
  assert.match(migration, /on private\.fam_site_error_counts[\s\S]*?for all to anon, authenticated[\s\S]*?using \(false\)[\s\S]*?with check \(false\)/i);
  assert.match(migration, /on private\.listing_image_moderation_queue[\s\S]*?for all to anon, authenticated[\s\S]*?using \(false\)[\s\S]*?with check \(false\)/i);
});

test("moderation queue indexes its user foreign key for efficient owner cleanup", () => {
  assert.match(migration, /create index if not exists listing_image_moderation_queue_user_id_idx[\s\S]*?on private\.listing_image_moderation_queue \(user_id\)/i);
});
