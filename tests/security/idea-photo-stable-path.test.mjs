import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute the real worker branch with bounded stubs, not a reimplementation.
// No network/storage access or student content is involved in these tests.
const source = readFileSync(
  new URL("../../supabase/functions/fam-listing-image-worker/index.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function processIdeaTask(task) {");
const end = source.indexOf("\nasync function scheduleIdeaRetryOrReview", start);
assert.ok(start !== -1 && end > start, "idea photo worker branch must exist");
const branch = source.slice(start, end);
const originalPath = "00000000-0000-4000-8000-000000000001/idea_00000000-0000-4000-8000-000000000002.jpg";
const task = { queue_id: "q", user_id: "00000000-0000-4000-8000-000000000001", image_path: originalPath, attempts: 1 };

function harness(options = {}) {
  const actions = [];
  const idea = { ai_status: "pending", image_paths: [originalPath] };
  const context = {
    safePendingIdeaPath: () => options.validPath !== false,
    createSignedIdeaUrl: async (path) => {
      actions.push({ type: "sign", path });
      if (options.signError) throw new Error(options.signError);
      return "https://example.invalid/private-photo";
    },
    callIdeaModeration: async () => options.moderation ?? { action: "ok" },
    finishIdea: async (_task, state) => {
      actions.push({ type: "finish", state });
      if (state === "approved") idea.ai_status = "approved";
      if (state === "rejected" || state === "failed") idea.image_paths = idea.image_paths.filter(path => path !== originalPath);
    },
    removeObject: async (bucket, path) => { actions.push({ type: "delete", bucket, path }); },
    isRetryableModerationFailure: () => true,
    scheduleIdeaRetryOrReview: async () => {
      actions.push({ type: "retry" });
      return "retry";
    },
    Error,
  };
  // The worker must not upload/copy an approved idea photo. Missing global
  // fetch makes the old implementation fail this test immediately.
  runInNewContext(branch + "\nthis.runTask = processIdeaTask;", context);
  return { run: () => context.runTask(task), actions, idea };
}

test("approved idea photo keeps its original storage path and file", async () => {
  const h = harness();
  assert.equal(await h.run(), "approved");
  assert.equal(h.idea.ai_status, "approved");
  assert.deepEqual(h.idea.image_paths, [originalPath]);
  assert.deepEqual(h.actions, [
    { type: "sign", path: originalPath },
    { type: "finish", state: "approved" },
  ]);
});

test("rejected idea photo removes only the rejected private file", async () => {
  const h = harness({ moderation: { action: "reject", reason_code: "unsafe_image" } });
  assert.equal(await h.run(), "rejected");
  assert.deepEqual(h.idea.image_paths, []);
  assert.deepEqual(h.actions, [
    { type: "sign", path: originalPath },
    { type: "finish", state: "rejected" },
    { type: "delete", bucket: "idea-images", path: originalPath },
  ]);
});

test("pending provider review does not delete the private photo", async () => {
  const h = harness({ moderation: { action: "pending", diagnostic_code: "openai_rate_limited" } });
  assert.equal(await h.run(), "retry");
  assert.deepEqual(h.idea.image_paths, [originalPath]);
  assert.deepEqual(h.actions, [{ type: "sign", path: originalPath }, { type: "retry" }]);
});

test("missing original photo marks it failed without generating a replacement", async () => {
  const h = harness({ signError: "staged_media_missing" });
  assert.equal(await h.run(), "failed");
  assert.deepEqual(h.idea.image_paths, []);
  assert.deepEqual(h.actions, [
    { type: "sign", path: originalPath },
    { type: "finish", state: "failed" },
  ]);
});

test("invalid queued path is rejected without signing or copying media", async () => {
  const h = harness({ validPath: false });
  assert.equal(await h.run(), "failed");
  assert.deepEqual(h.actions, [{ type: "finish", state: "failed" }]);
});

test("approved code cannot introduce a copied path or delete its referenced source", () => {
  assert.doesNotMatch(branch, /approved_idea_publish_failed_/);
  assert.doesNotMatch(branch, /const approvedPath =/);
  assert.doesNotMatch(branch, /removeObject\("idea-images", task\.image_path\)[\s\S]*return "approved"/);
});
