import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUDIT_TASK, getTaskReferencedPaths } from "../../scripts/local-coder-task.mjs";

test("default audit explicitly loads index.html into model context", () => {
  const tracked = ["index.html", "docs/README.md", "scripts/run-local-coder.mjs"];
  const allowed = (path) => path === "index.html" || path.startsWith("docs/");

  assert.match(DEFAULT_AUDIT_TASK, /index\\.html/);
  assert.deepEqual(getTaskReferencedPaths(tracked, DEFAULT_AUDIT_TASK, allowed), ["index.html"]);
});

test("task context respects the source allowlist and four-file limit", () => {
  const tracked = ["index.html", "docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "supabase/secret.sql"];
  const allowed = (path) => path === "index.html" || path.startsWith("docs/");
  const task = tracked.join(" ");

  assert.deepEqual(getTaskReferencedPaths(tracked, task, allowed), [
    "index.html", "docs/a.md", "docs/b.md", "docs/c.md",
  ]);
});
