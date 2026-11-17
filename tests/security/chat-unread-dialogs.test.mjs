import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("chat list identifies the conversation that owns unread messages", () => {
  assert.match(frontend, /const \[sentResult, receivedResult, unreadMessagesResult\] = await Promise\.all/);
  assert.match(frontend, /\.select\("sender_id", \{ count: "exact" \}\)/);
  assert.match(frontend, /const unreadByOther = new Map\(\)/);
  assert.match(frontend, /unreadCount: unreadByOther\.get\(otherId\) \|\| 0/);
  assert.match(frontend, /chat-unread-pill/);
});

test("chat history remains available when unread-detail metadata cannot be loaded", () => {
  const loader = frontend.slice(frontend.indexOf("async function loadDialogsList()"), frontend.indexOf("function updateAuthUI()"));
  assert.match(loader, /if \(sentResult\.error\) throw sentResult\.error/);
  assert.match(loader, /if \(receivedResult\.error\) throw receivedResult\.error/);
  assert.match(loader, /if \(unreadMessagesResult\.error \|\| !Number\.isFinite\(unreadMessagesResult\.count\)\)/);
  assert.doesNotMatch(loader, /if \(unreadMessagesResult\.error\) throw/);
});

test("old unread conversations remain visible even outside the recent preview window", () => {
  assert.match(frontend, /Preserve a conversation even when its unread message is older/);
  assert.match(frontend, /text: "Есть непрочитанные сообщения"/);
  assert.match(frontend, /unlistedUnreadCount/);
});

test("chat unread badge does not preserve a stale number when the count request fails", () => {
  assert.match(frontend, /if \(n === null\)[\s\S]*b\.textContent = "\?"/);
  assert.match(frontend, /Do not leave an old number visible/);
  assert.match(frontend, /if \(!Number\.isFinite\(count\)\) throw/);
});
