import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const workflow = readFileSync(new URL("../../.github/workflows/moderation-regression.yml", import.meta.url), "utf8");
test("postmerge and pull request CI cover every approved patch area", () => {
  const triggers = workflow.split("permissions:")[0];
  const push = triggers.split("  push:")[1].split("  pull_request:")[0];
  const pr = triggers.split("  pull_request:")[1];
  for (const section of [push,pr]) {
    for (const path of ["index.html","js/**","css/**","assets/**","docs/**","tests/**","scripts/**"]) {
      assert.ok(section.includes("'" + path + "'"), "Missing path: " + path);
    }
  }
  assert.match(workflow,/actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow,/actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow,/inlineScripts\.join/);
  assert.doesNotMatch(workflow,/\.find\(\(script\)/);
});
