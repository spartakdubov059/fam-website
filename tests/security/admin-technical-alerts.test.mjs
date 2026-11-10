import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261110174043_fam_admin_technical_alerts.sql", import.meta.url),
  "utf8",
);
const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("technical alerts are restricted to authenticated school administrators", () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /p\.role = 'school_admin'/i);
  assert.match(migration, /\(select auth\.uid\(\)\) is not null/i);
  assert.match(migration, /revoke all on function public\.get_fam_admin_technical_alerts\(\) from public,anon,authenticated,service_role/i);
  assert.match(migration, /grant execute on function public\.get_fam_admin_technical_alerts\(\) to authenticated/i);
  assert.match(frontend, /profile\?\.role === "school_admin"\s*\?\s*sb\.rpc\("get_fam_admin_technical_alerts"\)/);
});

test("alerts use hourly aggregate counters and fixed thresholds, not personal data", () => {
  assert.match(migration, /private\.fam_site_error_counts/i);
  assert.match(migration, /interval '24 hours'/i);
  assert.match(migration, /when 'database_request_failed' then 3/i);
  assert.match(migration, /when 'auth_backend_failed' then 5/i);
  assert.match(frontend, /technicalEventLabels/);
  assert.match(frontend, /notification_key/);
  assert.doesNotMatch(frontend, /technicalAlertsResult\.data[\s\S]{0,1200}(?:email|user_id|message_body|stack)/i);
});

test("technical alerts are integrated with existing per-account read and dismiss behavior", () => {
  assert.match(frontend, /notificationsCache = items\.sort/);
  assert.match(frontend, /data-action="mark-notification-read"/);
  assert.match(frontend, /data-action="dismiss-notification"/);
  assert.match(frontend, /onConflict: "user_id,notification_key"/);
});
