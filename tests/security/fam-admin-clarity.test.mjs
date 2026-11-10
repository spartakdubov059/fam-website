import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const adminFunction = readFileSync(
  new URL("../../supabase/functions/council-management/index.ts", import.meta.url),
  "utf8",
);

test("notification read-state failures do not resurrect dismissed notifications", () => {
  assert.match(frontend, /notification_read_state_load_failed[\\s\\S]*Fail closed:[\\s\\S]*return;/);
  assert.match(frontend, /notification_key: "dismissed:" \\+ id/);
});

test("opening the notification bell marks visible notifications read", () => {
  assert.match(frontend, /if \\(notifOpen\\) \\{[\\s\\S]*markNotificationsRead\\(unreadIds\\)/);
  assert.match(frontend, /upsert\\(rows, \\{ onConflict: "user_id,notification_key" \\}\\)/);
});

test("chat unread badge uses an exact count, not a capped page", () => {
  assert.match(frontend, /select\\("id", \\{ count: "exact", head: true \\}\\)/);
  assert.doesNotMatch(frontend, /updateChatBadge[\\s\\S]{0,500}limit\\(1000\\)/);
});

test("school-facing notification feed does not expose developer technical alerts", () => {
  assert.doesNotMatch(frontend, /get_fam_admin_technical_alerts|technicalAlertsResult|Критический сбой FAM/);
});

test("school admin overview returns listing moderation status", () => {
  assert.match(adminFunction, /moderation_status,is_event/);
  assert.match(adminFunction, /moderation_status: row\\.moderation_status/);
  assert.match(frontend, /Нужна дополнительная проверка/);
});

test("one concise announcements section is rendered in the profile", () => {
  assert.equal((frontend.match(/id="profileListingsPanel"/g) || []).length, 1);
});
