import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationDirectory = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

test("migration filenames match the versions already recorded in FAM production", () => {
  const files = new Set(readdirSync(migrationDirectory));
  const appliedFiles = [
    "20261109152842_school_scoped_agent_reports_and_free_analysts.sql",
    "20261110181754_20261110180500_fam_agent_moscow_morning_schedule.sql",
    "20261110210025_add_persistent_listing_image_review_queue.sql",
    "20261111164217_restrict_unapproved_ideas_from_council.sql",
    "20261111182622_recover_expired_fam_coder_tasks_after_final_attempt.sql",
    "20261111183253_monitor_qwen_coder_producer_schedule.sql",
    "20261111184531_scope_qwen_retry_reaper_to_claimed_system_tasks.sql",
  ];
  const staleFiles = [
    "20261109162500_school_scoped_agent_reports_and_free_analysts.sql",
    "20261110180500_fam_agent_moscow_morning_schedule.sql",
    "20261110204600_add_persistent_listing_image_review_queue.sql",
    "20261111163500_restrict_unapproved_ideas_from_council.sql",
  ];

  for (const file of appliedFiles) {
    assert.ok(files.has(file), `Missing production migration version: ${file}`);
  }
  for (const file of staleFiles) {
    assert.ok(!files.has(file), `Stale migration version could be reapplied: ${file}`);
  }
});


test("migration version prefixes are unique across the repository", () => {
  const versions = new Map();
  const migrationFiles = readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql"));
  for (const file of migrationFiles) {
    const version = file.match(/^(\d{14})_/i)?.[1];
    assert.ok(version, `Invalid Supabase migration filename: ${file}`);
    const previous = versions.get(version);
    assert.equal(previous, undefined, `Duplicate Supabase migration version ${version}: ${previous}, ${file}`);
    versions.set(version, file);
  }
});
