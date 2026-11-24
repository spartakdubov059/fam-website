import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../../supabase/migrations/20261124210000_make_fam_event_images_private.sql", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const pulse = readFileSync(new URL("../../school-pulse.js", import.meta.url), "utf8");

test("archived event photos are private and readable only by their owner", () => {
  assert.match(sql, /update storage\.buckets[\s\S]*set public = false[\s\S]*id = 'event-images'/);
  assert.match(sql, /drop policy if exists "public_read_event_images" on storage\.objects/);
  assert.match(sql, /for select\s+to authenticated\s+using/i);
  assert.match(sql, /bucket_id = 'event-images'/);
  assert.match(sql, /storage\.foldername\(name\)/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.doesNotMatch(sql, /delete\s+from\s+storage\.objects|truncate\s+storage\.objects/i);
});

test("current school feed does not rely on direct public archived event URLs", () => {
  assert.equal(html.includes("/object/public/event-images/"), false);
  assert.equal(pulse.includes("/object/public/event-images/"), false);
});
