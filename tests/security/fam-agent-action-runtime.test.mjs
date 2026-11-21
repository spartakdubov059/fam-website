import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paths = [
  "../../.github/workflows/fam-agent-governance.yml",
  "../../.github/workflows/fam-codex-developer.yml",
  "../../.github/workflows/moderation-regression.yml",
  "../../.github/workflows/qwen-model-benchmark.yml",
];
const workflows = paths.map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const all = workflows.join("\n");
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "53b83947a5a98c8d113130e565377fae1a50d02f";

test("AI and QA workflows use reviewed Node 24-compatible checkout across every job", () => {
  const uses = [...all.matchAll(/uses:\s*actions\/checkout@([^\s]+)/g)].map((match) => match[1]);
  assert.equal(uses.length, 7);
  assert.ok(uses.every((ref) => ref === CHECKOUT_SHA), "all checkout actions must pin the reviewed v7.0.1 commit");
  assert.doesNotMatch(all, /actions\/checkout@v4|actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
});

test("agent workflows do not persist checkout credentials", () => {
  const blocks = all.split(/(?=\s*- (?:name: [^\n]+\n\s*)?uses: actions\/checkout@)/).filter((x) => x.includes("actions/checkout@"));
  assert.equal(blocks.length, 7);
  for (const block of blocks) assert.match(block, /persist-credentials:\s*false/);
});

test("moderation regression runner uses the reviewed Node 24 setup-node release", () => {
  const regression = workflows[2];
  assert.match(regression, new RegExp(`actions/setup-node@${SETUP_NODE_SHA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(regression, /actions\/setup-node@v4/);
});
