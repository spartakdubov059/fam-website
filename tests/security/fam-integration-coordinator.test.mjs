import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntegrationPlan,
  formatIntegrationPlan,
} from "../../scripts/fam-integration-coordinator.mjs";
import {
  proposeRecruitment,
  makeReport,
} from "../../scripts/fam-agent-governance.mjs";

test("INTEGRATOR groups transitive conflicts without inventing separate groups", () => {
  const plan = buildIntegrationPlan({
    pulls: [
      { number: 12, draft: false },
      { number: 10, draft: true },
      { number: 11, draft: false },
      { number: 20, draft: false },
      { number: 21, draft: true },
    ],
    disputes: [
      { prs: [10, 11], files: ["scripts/runner.mjs"], highRisk: true },
      { prs: [11, 12], files: ["index.html"], highRisk: false },
      { prs: [20, 21], files: ["index.html"], highRisk: false },
    ],
  });
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.groups[0].prs, [10, 11, 12]);
  assert.deepEqual(plan.groups[0].reviewSequence, [11, 12, 10]);
  assert.deepEqual(plan.groups[0].draft, [10]);
  assert.equal(plan.groups[0].conflictCount, 2);
  assert.equal(plan.groups[0].highRisk, true);
  assert.deepEqual(plan.groups[1].prs, [20, 21]);
  assert.equal(plan.overlapPairs, 3);
});

test("INTEGRATOR never assigns an automatic winner or a merge order", () => {
  const p = buildIntegrationPlan({
    pulls: [{ number: 2, draft: false }, { number: 1, draft: true }],
    disputes: [{ prs: [1, 2], files: ["index.html"] }],
  });
  const report = formatIntegrationPlan(p);
  assert.match(report, /очередь проверки/i);
  assert.match(report, /#2 → #1/);
  assert.match(report, /черновики: #1/);
  assert.match(report, /Выбрать основной PR вручную/);
  assert.doesNotMatch(report, /автоматического merge разрешено/);
});

test("INTEGRATOR ignores malformed edge input and marks partial evidence", () => {
  const p = buildIntegrationPlan({
    pulls: [],
    disputes: [
      { prs: ["not-a-pr", 2], files: ["index.html"] },
      { prs: [1, 1], files: ["index.html"] },
      { prs: [2, 3], files: [] },
      { prs: [6, 7], files: ["supabase/functions/f.ts"] },
    ],
    limited: true,
  });
  assert.equal(p.groups.length, 1);
  const result = formatIntegrationPlan(p);
  assert.match(result, /Выборка PR или списков файлов неполная/);
  assert.match(result, /Высокий риск/);
});

test("INTEGRATOR escapes untrusted file paths before writing GitHub issue", () => {
  const p = buildIntegrationPlan({
    pulls: [{ number: 1 }, { number: 2 }],
    disputes: [{
      prs: [1, 2],
      files: ["web/<script>alert(1)</script>.js", "scripts/a.mjs"],
    }],
  });
  const report = formatIntegrationPlan(p);
  assert.ok(!report.includes("<script>"));
  assert.match(report, /&lt;script&gt;/);
});

test("RECRUITER stops suggesting a specialist after it has been hired", () => {
  const gaps = [{ prs: [1, 2] }, { prs: [2, 3] }, { prs: [1, 3] }];
  assert.equal(proposeRecruitment({ disputes: gaps }).at(0).key, "integration_specialist");
  assert.deepEqual(proposeRecruitment({
    disputes: gaps, activeRoles: ["integration_specialist"],
  }), []);
});

test("INTEGRATOR appears in the existing single governance issue report", () => {
  const plan = buildIntegrationPlan({
    pulls: [{ number: 1, draft: false }, { number: 2, draft: false }],
    disputes: [{ prs: [1, 2], files: [".github/workflows/a.yml"] }],
  });
  const report = makeReport({
    integrationPlan: plan,
    disputes: [{ prs: [1, 2], files: [".github/workflows/a.yml"], highRisk: true }],
    now: Date.parse("2026-11-13T19:00:00Z"),
  });
  assert.match(report, /## INTEGRATOR/);
  assert.match(report, /## RECRUITER/);
  assert.match(report, /## INSPECTOR/);
  assert.match(report, /защищённых файлов/);
});
