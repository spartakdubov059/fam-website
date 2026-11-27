import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const start = frontend.indexOf("  async function clearNotifications() {");
const end = frontend.indexOf("\n  window.closeNotifPanel", start);
assert.ok(start !== -1 && end > start, "bulk dismissal function must exist in FAM");
const source = frontend.slice(start, end);

function harness(items, options = {}) {
  const operations = [];
  const context = {
    user: { id: "current-user" },
    notificationsCache: items.map(item => ({ ...item })),
    notice: message => operations.push({ kind: "notice", message }),
    updateBellBadge: () => operations.push({ kind: "badge" }),
    renderNotifPanel: () => operations.push({ kind: "render" }),
    updateChatBadge: async () => operations.push({ kind: "chat-badge" }),
    Date,
  };
  context.sb = {
    from(table) {
      if (table === "messages") {
        return {
          update(values) {
            return {
              eq(field, value) {
                return {
                  in(field2, ids) {
                    operations.push({
                      kind: "messages",
                      values: { ...values },
                      filter: { [field]: value, [field2]: [...ids] },
                    });
                    options.afterMessageRequest?.(context);
                    return Promise.resolve({ error: options.messageError || null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "notification_reads") {
        return {
          upsert(rows, config) {
            operations.push({
              kind: "dismissals",
              rows: Array.from(rows, row => ({ ...row })),
              onConflict: config.onConflict,
            });
            options.duringUpsert?.(context);
            return Promise.resolve({ error: options.upsertError || null });
          },
        };
      }
      throw new Error("Unexpected database table: " + table);
    },
  };
  runInNewContext(source + "\nthis.dismissAll = clearNotifications;", context);
  return { context, operations, run: () => context.dismissAll() };
}

const mixed = [
  { id: "message:a", kind: "message", recordId: "a" },
  { id: "school-news:b", kind: "listing" },
  { id: "message:c", kind: "message", recordId: "c" },
];

test("clearing multiple notifications uses one message update and one dismissal upsert", async () => {
  const h = harness(mixed);
  await h.run();
  const updates = h.operations.filter(op => op.kind === "messages");
  const dismissals = h.operations.filter(op => op.kind === "dismissals");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].values, { is_read: true });
  assert.deepEqual(updates[0].filter, { receiver_id: "current-user", id: ["a", "c"] });
  assert.equal(dismissals.length, 1);
  assert.equal(dismissals[0].onConflict, "user_id,notification_key");
  assert.deepEqual(dismissals[0].rows.map(row => row.notification_key), [
    "dismissed:message:a", "dismissed:school-news:b", "dismissed:message:c",
  ]);
  assert.ok(dismissals[0].rows.every(row => row.user_id === "current-user" && row.read_at));
  assert.equal(h.context.notificationsCache.length, 0);
  assert.equal(h.operations.filter(op => op.kind === "badge").length, 1);
  assert.equal(h.operations.filter(op => op.kind === "render").length, 1);
});

test("empty notification feed makes no database requests", async () => {
  const h = harness([]);
  await h.run();
  assert.deepEqual(h.operations, []);
});

test("message update failure preserves the feed and does not persist dismissals", async () => {
  const h = harness(mixed, { messageError: { message: "temporary network error" } });
  await h.run();
  assert.equal(h.context.notificationsCache.length, mixed.length);
  assert.equal(h.operations.filter(op => op.kind === "dismissals").length, 0);
  assert.equal(h.operations.filter(op => op.kind === "notice").length, 1);
  assert.equal(h.operations.filter(op => op.kind === "render").length, 0);
});

test("notification-state write failure preserves the feed", async () => {
  const h = harness(mixed, { upsertError: { message: "upsert denied" } });
  await h.run();
  assert.equal(h.context.notificationsCache.length, mixed.length);
  assert.equal(h.operations.filter(op => op.kind === "notice").length, 1);
  assert.equal(h.operations.filter(op => op.kind === "render").length, 0);
});

test("notifications arriving while dismissals save remain visible", async () => {
  const h = harness(mixed, {
    duringUpsert: context => context.notificationsCache.push({ id: "message:new", kind: "message", recordId: "new" }),
  });
  await h.run();
  assert.deepEqual(Array.from(h.context.notificationsCache, note => note.id), ["message:new"]);
});

test("account switch during network request cannot clear another account's feed", async () => {
  const h = harness(mixed, {
    afterMessageRequest: context => {
      context.user = { id: "another-user" };
      context.notificationsCache = [{ id: "another:notification", kind: "listing" }];
    },
  });
  await h.run();
  assert.deepEqual(Array.from(h.context.notificationsCache, note => note.id), ["another:notification"]);
  assert.equal(h.operations.filter(op => op.kind === "dismissals").length, 0);
});
