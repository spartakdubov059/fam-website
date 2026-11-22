import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateClaimResponse } from "../../scripts/fam-agent-bridge.mjs";

const workflow = readFileSync(
  new URL("../../.github/workflows/fam-codex-developer.yml", import.meta.url),
  "utf8",
);
const bridge = readFileSync(
  new URL("../../supabase/functions/fam-agent-coder-bridge/index.ts", import.meta.url),
  "utf8",
);
const runbook = readFileSync(
  new URL("../../docs/FAM_AGENT_LIVE_SMOKE_20261122.md", import.meta.url),
  "utf8",
);

test("live smoke doc push activates the existing main-only AI workflow", () => {
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.ok(workflow.includes('"docs/**"'));
  assert.match(workflow, /node scripts\/fam-agent-bridge\.mjs claim/);
  assert.match(workflow, /node scripts\/fam-agent-bridge\.mjs finish/);
  assert.match(workflow, /node scripts\/validate-local-agent-patch\.mjs/);
  assert.match(workflow, /gh pr create/);
  assert.doesNotMatch(workflow, /gh pr merge|git push origin main/);
});

test("smoke task is a zero-occurrence aggregate-only audit, not a fabricated incident", () => {
  assert.match(runbook, /audit_accessibility/);
  assert.match(runbook, /occurrences: 0/);
  assert.match(runbook, /Никакой реальный сбой не утверждается/);
  assert.match(runbook, /без утверждения о реальной ошибке/);
  const valid = validateClaimResponse({
    ok: true,
    task: {
      id: "123e4567-e89b-42d3-a456-426614174000",
      task_key: "audit_accessibility",
      event_code: "js_runtime",
      page_area: "other",
      occurrences: 0,
      user_id: "must-never-reach-Qwen",
      arbitrary_payload: "must-never-reach-Qwen",
    },
  });
  assert.equal(valid.task_key, "audit_accessibility");
  assert.doesNotMatch(valid.prompt, /must-never-reach-Qwen/);
  assert.deepEqual(Object.keys(valid), ["id", "task_key", "prompt"]);
});

test("server bridge has fixed claim/finish contracts, no raw task instructions", () => {
  assert.match(bridge, /body\.action === "claim"/);
  assert.match(bridge, /body\.action === "finish"/);
  assert.match(bridge, /p_limit: 1/);
  assert.match(bridge, /p_lease_seconds: 7200/);
  assert.match(bridge, /origin_not_allowed/);
  assert.match(bridge, /sameSecret/);
  assert.doesNotMatch(bridge, /rpc\(body\./);
  assert.doesNotMatch(bridge, /task:\s*\{[^}]*\bpayload\b/);
});

test("smoke run cannot imply model output is already an approved production fix", () => {
  assert.match(runbook, /model_completed/);
  assert.match(runbook, /не равен/);
  assert.match(runbook, /Решение владельца|решению владельца|решение владельца/);
  assert.match(workflow, /Production этим workflow не изменяется/);
  assert.match(workflow, /требуется отдельное явное разрешение владельца/);
});
