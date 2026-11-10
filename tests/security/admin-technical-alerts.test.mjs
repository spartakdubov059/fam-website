import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261110174043_fam_admin_technical_alerts.sql", import.meta.url),
  "utf8",
);
const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("technical alert data is aggregate-only and stays out of the school-facing FAM UI", () => {
  assert.match(migration, /private\.fam_site_error_counts/i);
  assert.match(migration, /interval '24 hours'/i);
  assert.match(migration, /when 'database_request_failed' then 3/i);
  assert.match(migration, /when 'auth_backend_failed' then 5/i);
  assert.doesNotMatch(frontend, /get_fam_admin_technical_alerts|technicalEventLabels|technicalAlertsResult/);
});

test("the developer report pipeline remains separate from the FAM UI", () => {
  assert.match(frontend, /notificationsCache = items\.sort/);
  assert.match(frontend, /data-action="mark-notification-read"/);
  assert.match(frontend, /data-action="dismiss-notification"/);
  assert.match(frontend, /onConflict: "user_id,notification_key"/);
});
