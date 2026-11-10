import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const originalMigration = readFileSync(
  new URL("../../supabase/migrations/20261110174043_fam_admin_technical_alerts.sql", import.meta.url),
  "utf8",
);
const revokeMigration = readFileSync(
  new URL("../../supabase/migrations/20261110220017_revoke_school_admin_technical_alert_rpc.sql", import.meta.url),
  "utf8",
);
const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("technical alert data is aggregate-only and is no longer exposed to school accounts", () => {
  assert.match(originalMigration, /private\.fam_site_error_counts/i);
  assert.match(originalMigration, /interval '24 hours'/i);
  assert.match(originalMigration, /when 'database_request_failed' then 3/i);
  assert.match(originalMigration, /when 'auth_backend_failed' then 5/i);
  assert.match(revokeMigration, /revoke all on function public\.get_fam_admin_technical_alerts\(\) from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(revokeMigration, /grant execute/i);
  assert.doesNotMatch(frontend, /get_fam_admin_technical_alerts|technicalEventLabels|technicalAlertsResult/);
});

test("developer reporting remains separate from the school-facing FAM interface", () => {
  assert.match(frontend, /notificationsCache = items\.sort/);
  assert.match(frontend, /data-action="mark-notification-read"/);
  assert.match(frontend, /data-action="dismiss-notification"/);
  assert.match(frontend, /onConflict: "user_id,notification_key"/);
});
