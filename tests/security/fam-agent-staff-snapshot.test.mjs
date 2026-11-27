import test from "node:test";
import assert from "node:assert/strict";
import { buildStaffSnapshot, renderStaffSnapshot } from "../../scripts/fam-agent-staff-snapshot.mjs";
import { makeReport } from "../../scripts/fam-agent-governance.mjs";

test("staff snapshot always includes the nine approved roles and marks missing telemetry", () => {
  const rows = buildStaffSnapshot({ qwen: { state: "confirmed", evidence_count: 2, detail: "2 runs" } });
  assert.equal(rows.length, 9);
  assert.equal(rows.find((row) => row.key === "qwen").state, "confirmed");
  assert.ok(rows.filter((row) => row.key !== "qwen").every((row) => row.state === "no_data"));
  assert.match(renderStaffSnapshot({}), /отсутствие данных не считается успехом/);
});

test("snapshot rejects invented statuses, unsafe counters and untrusted formatting", () => {
  const report = renderStaffSnapshot({
    legal: { state: "approved", evidence_count: -1, detail: "\n<unsafe>" },
  });
  assert.match(report, /Юрист \(LEGAL\).*нет подтверждённых данных/);
  assert.match(report, /Подтверждённый источник результатов не подключён/);
  assert.doesNotMatch(report, /<unsafe>/);
  assert.doesNotMatch(report, /approved/);
});

test("existing governance report includes the nine-role snapshot without inventing missing outcomes", () => {
  const report = makeReport({ now: Date.parse("2026-11-27T04:00:00Z") });
  for (const role of ["Босс (ARBITER)", "Проверяющий (INSPECTOR)", "Юрист (LEGAL)", "Разработчик (Qwen)", "Испытатель (QA)", "Связной (INTEGRATOR)", "Советник штаба (RECRUITER)", "Надзиратель (MODERATOR)", "Советник по развитию"]) {
    assert.ok(report.includes(role), "missing " + role);
  }
  assert.match(report, /нет подтверждённых данных/);
  assert.match(report, /выполнять merge или публиковать сайт/);
});
