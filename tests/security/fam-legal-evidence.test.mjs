import test from "node:test";
import assert from "node:assert/strict";
import {
  appendLegalArchiveEntry,
  evaluateLegalReadiness,
  scopesForLegalAssessment,
  verifyLegalArchive,
} from "../../scripts/fam-legal-evidence.mjs";

const REVISION = "a".repeat(40);
const SOURCE = "https://publication.pravo.gov.ru/document/0001202601010001";
const baseEntry = (overrides = {}) => ({
  scope: "FAM_CURRENT", revision: REVISION, criterion_id: "official_source_review",
  source_url: SOURCE, checked_at: "2026-11-27T04:00:00Z", status: "operator_reviewed",
  priority: "advisory", decision: "confirmed", ...overrides,
});
const criterionIds = ["official_source_review", "scope_applicability_review", "student_data_minimization_review",
  "access_control_review", "qualified_counsel_review"];
const fullCriteria = (overrides = {}) => criterionIds.map((criterion_id) => ({
  criterion_id, applicability: "applicable", reason: "scope_declared", ...(overrides[criterion_id] || {}),
}));

test("archive is append-only, hash chained, idempotent for the same event, and rejects edits", () => {
  const first = appendLegalArchiveEntry([], baseEntry());
  assert.equal(verifyLegalArchive(first), true);
  assert.equal(first[0].previous_entry_hash, null);
  assert.equal(appendLegalArchiveEntry(first, baseEntry()), first);
  const second = appendLegalArchiveEntry(first, baseEntry({
    criterion_id: "scope_applicability_review", checked_at: "2026-11-27T05:00:00Z",
  }));
  assert.equal(second.length, 2);
  assert.equal(second[1].previous_entry_hash, first[0].entry_hash);
  assert.equal(verifyLegalArchive(second), true);
  assert.equal(verifyLegalArchive([{ ...first[0], decision: "rejected" }]), false);
  assert.equal(verifyLegalArchive([{ ...first[0], student_email: "synthetic@example.invalid" }]), false);
});

test("archive accepts only allowlisted public official HTTPS sources and bounded fields", () => {
  assert.throws(() => appendLegalArchiveEntry([], baseEntry({ source_url: "http://publication.pravo.gov.ru/a" })), /invalid/);
  assert.throws(() => appendLegalArchiveEntry([], baseEntry({ source_url: "https://example.org/law" })), /invalid/);
  assert.throws(() => appendLegalArchiveEntry([], baseEntry({ source_url: SOURCE + "?email=x" })), /invalid/);
  assert.throws(() => appendLegalArchiveEntry([], { ...baseEntry(), summary: "student name" }), /unknown or missing fields/);
  assert.throws(() => appendLegalArchiveEntry([], baseEntry({
    criterion_id: "qualified_counsel_review", status: "operator_reviewed", decision: "confirmed",
  })), /Qualified counsel evidence/);
  assert.throws(() => appendLegalArchiveEntry([], baseEntry({
    status: "source_unavailable", decision: "confirmed",
  })), /status and decision/);
});

test("scope readiness is isolated and human evidence is required before counting criteria", () => {
  let current = [];
  for (const [index, criterion_id] of criterionIds.entries()) {
    current = appendLegalArchiveEntry(current, baseEntry({
      criterion_id,
      checked_at: `2026-11-27T04:00:0${index}Z`,
      status: criterion_id === "qualified_counsel_review" ? "counsel_reviewed" : "operator_reviewed",
    }));
  }
  const criteria = fullCriteria();
  const withoutVerifier = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria, archive: current });
  assert.equal(withoutVerifier.readiness_percent, 0);
  assert.equal(withoutVerifier.status, "evidence_pending_human_review");
  assert.equal(withoutVerifier.release_gate, "not_authorized_by_legal_evidence");
  const knownEntries = new Set(current.map((entry) => entry.entry_hash));
  const verifyExactEntry = (entry) => knownEntries.has(entry.entry_hash);
  const verified = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria, archive: current, verifyHumanDecision: verifyExactEntry });
  assert.equal(verified.readiness_percent, 100);
  assert.equal(verified.status, "criteria_evidenced_pending_release_decision");
  assert.equal(verified.authority.includes("release approval are not provided"), true);
  const ru = evaluateLegalReadiness({ scope: "FAM_RU", revision: REVISION, criteria, archive: current, verifyHumanDecision: verifyExactEntry });
  assert.equal(ru.readiness_percent, 0);
  const verifierError = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria, archive: current,
    verifyHumanDecision: () => { throw new Error("unavailable"); } });
  assert.equal(verifierError.verified_criteria, 0);
  assert.equal(verifierError.status, "evidence_pending_human_review");
  assert.deepEqual(scopesForLegalAssessment("SHARED"), ["FAM_CURRENT", "FAM_RU"]);
  assert.throws(() => scopesForLegalAssessment("unknown"), /explicit product scope/);
});

test("a newer legal archive decision supersedes older approval for the same criterion", () => {
  let archive = [];
  for (const [index, criterion_id] of criterionIds.entries()) {
    archive = appendLegalArchiveEntry(archive, baseEntry({
      criterion_id,
      checked_at: `2026-11-27T04:00:0${index}Z`,
      status: criterion_id === "qualified_counsel_review" ? "counsel_reviewed" : "operator_reviewed",
    }));
  }
  archive = appendLegalArchiveEntry(archive, baseEntry({
    checked_at: "2026-11-27T06:00:00Z",
    status: "operator_reviewed",
    decision: "rejected",
  }));
  const trustedEntries = new Set(archive.map((entry) => entry.entry_hash));
  const result = evaluateLegalReadiness({
    scope: "FAM_CURRENT", revision: REVISION, criteria: fullCriteria(), archive,
    verifyHumanDecision: (entry) => trustedEntries.has(entry.entry_hash),
  });
  assert.equal(result.verified_criteria, 4);
  assert.equal(result.readiness_percent, 80);
  assert.ok(result.pending_criteria.includes("official_source_review"));
});

test("a newer pending record cannot reuse old not-applicable approval", () => {
  let archive = appendLegalArchiveEntry([], baseEntry({
    status: "not_applicable", priority: "unassessed", decision: "not_applicable",
  }));
  archive = appendLegalArchiveEntry(archive, baseEntry({
    checked_at: "2026-11-27T05:00:00Z", status: "source_checked", priority: "unassessed",
    decision: "pending_human_review",
  }));
  const trustedEntries = new Set([archive[0].entry_hash, ...archive.slice(2).map((entry) => entry.entry_hash)]);
  const criteria = fullCriteria({
    official_source_review: { applicability: "not_applicable", reason: "outside_release_scope" },
  });
  const result = evaluateLegalReadiness({
    scope: "FAM_CURRENT", revision: REVISION, criteria, archive,
    verifyHumanDecision: (entry) => trustedEntries.has(entry.entry_hash),
  });
  assert.equal(result.status, "not_assessed");
  assert.equal(result.readiness_percent, null);
  assert.ok(result.pending_criteria.includes("official_source_review"));
});

test("unknown applicability and unsupported exclusions produce no readiness percentage", () => {
  const unknown = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria: fullCriteria({
    official_source_review: { applicability: "unknown", reason: "undetermined" },
  }) });
  assert.equal(unknown.status, "not_assessed");
  assert.equal(unknown.readiness_percent, null);
  assert.ok(unknown.pending_criteria.includes("official_source_review"));
  const falseNA = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria: fullCriteria({
    official_source_review: { applicability: "not_applicable", reason: "outside_release_scope" },
  }) });
  assert.equal(falseNA.status, "not_assessed");
  assert.equal(falseNA.applicable_criteria, null);
  const incomplete = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria: [
    { criterion_id: "official_source_review", applicability: "applicable", reason: "scope_declared" },
  ] });
  assert.equal(incomplete.readiness_percent, null);
  assert.equal(incomplete.pending_criteria.length, 4);
  assert.throws(() => evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria: fullCriteria({
    official_source_review: { applicability: "applicable", reason: "outside_release_scope" },
  }) }), /reason does not match applicability/);
});

test("counsel review is not inferred from operator review", () => {
  const archive = appendLegalArchiveEntry([], baseEntry({
    criterion_id: "qualified_counsel_review", status: "counsel_reviewed", decision: "confirmed",
  }));
  const result = evaluateLegalReadiness({
    scope: "FAM_CURRENT", revision: REVISION,
    criteria: fullCriteria(),
    archive,
  });
  assert.equal(result.verified_criteria, 0);
  assert.equal(result.readiness_percent, 0);
});
