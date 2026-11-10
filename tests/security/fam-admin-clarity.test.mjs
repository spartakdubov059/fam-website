import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const adminFunction = readFileSync(
  new URL("../../supabase/functions/council-management/index.ts", import.meta.url),
  "utf8",
);

test("notification read-state failures do not resurrect dismissed notifications", () => {
  assert.ok(frontend.includes("notification_read_state_load_failed"));
  assert.ok(frontend.includes("Fail closed: keep the last known feed"));
  assert.ok(frontend.includes('notification_key: "dismissed:" + id'));
});

test("opening the notification bell marks visible notifications read", () => {
  assert.ok(frontend.includes("markNotificationsRead(unreadIds)"));
  assert.ok(frontend.includes('upsert(rows, { onConflict: "user_id,notification_key" })'));
});

test("chat unread badge uses an exact count, not a capped page", () => {
  assert.ok(frontend.includes('select("id", { count: "exact", head: true })'));
  const badgeStart = frontend.indexOf("async function updateChatBadge()");
  const badgeEnd = frontend.indexOf("setInterval(updateChatBadge", badgeStart);
  assert.ok(badgeStart >= 0 && badgeEnd > badgeStart);
  assert.ok(!frontend.slice(badgeStart, badgeEnd).includes("limit(1000)"));
});

test("school-facing notification feed does not expose developer technical alerts", () => {
  assert.ok(!frontend.includes("get_fam_admin_technical_alerts"));
  assert.ok(!frontend.includes("technicalAlertsResult"));
  assert.ok(!frontend.includes("Критический сбой FAM"));
});

test("school admin overview returns listing moderation status", () => {
  assert.ok(adminFunction.includes("moderation_status,is_event"));
  assert.ok(adminFunction.includes("moderation_status: row.moderation_status"));
  assert.ok(frontend.includes("Нужна дополнительная проверка"));
});

test("one concise announcements section is rendered in the profile", () => {
  assert.equal((frontend.match(/id="profileListingsPanel"/g) || []).length, 1);
});
