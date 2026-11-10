import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261110204600_add_persistent_listing_image_review_queue.sql", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../../supabase/functions/fam-listing-image-worker/index.ts", import.meta.url),
  "utf8",
);

test("listing image moderation worker is scheduled every minute", () => {
  assert.match(migration, /fam-listing-image-moderation-every-minute/);
  assert.match(migration, /'\* \* \* \* \*'/);
  assert.match(migration, /functions\/v1\/fam-listing-image-worker/);
});

test("image worker requires the dedicated internal token and POST requests", () => {
  assert.match(worker, /Deno\.env\.get\(["']FAM_AGENT_WORKER_TOKEN["']\)/);
  assert.match(worker, /x-fam-agent-token/);
  assert.match(worker, /sameSecret\(req\.headers\.get\("x-fam-agent-token"\)\s*\|\|\s*""\s*,\s*WORKER_TOKEN\)/);
  assert.match(worker, /req\.method !== "POST"/);
});

test("image worker routes queued image checks through the established moderation function", () => {
  assert.match(worker, /claim_listing_image_moderation_tasks/);
  assert.match(worker, /functions\/v1\/moderate/);
  assert.match(worker, /finish_listing_image_moderation_task/);
});
