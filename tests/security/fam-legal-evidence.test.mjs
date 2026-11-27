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

test("scope readiness is isolated and human evidence is required before counting a criterion", () => {
  const current = appendLegalArchiveEntry([], baseEntry());
  const criteria = [{ criterion_id: "official_source_review", applicability: "applicable", reason: "scope_declared" }];
  const withoutVerifier = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria, archive: current });
  assert.equal(withoutVerifier.readiness_percent, 0);
  assert.equal(withoutVerifier.status, "evidence_pending_human_review");
  assert.equal(withoutVerifier.release_gate, "not_authorized_by_legal_evidence");
  const verifyExactEntry = (entry) => entry.entry_hash === current[0].entry_hash;
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

test("unknown applicability and unsupported exclusions produce no readiness percentage", () => {
  const unknown = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria: [
    { criterion_id: "official_source_review", applicability: "unknown", reason: "undetermined" },
  ] });
  assert.equal(unknown.status, "not_assessed");
  assert.equal(unknown.readiness_percent, null);
  const falseNA = evaluateLegalReadiness({ scope: "FAM_CURRENT", revision: REVISION, criteria: [
    { criterion_id: "official_source_review", applicability: "not_applicable", reason: "outside_release_scope" },
  ] });
  assert.equal(falseNA.status, "not_assessed");
  assert.equal(falseNA.applicable_criteria, null);
});

test("counsel review is not inferred from operator review", () => {
  const archive = appendLegalArchiveEntry([], baseEntry({
    criterion_id: "qualified_counsel_review", status: "counsel_reviewed", decision: "confirmed",
  }));
  const result = evaluateLegalReadiness({
    scope: "FAM_CURRENT", revision: REVISION,
    criteria: [{ criterion_id: "qualified_counsel_review", applicability: "applicable", reason: "scope_declared" }],
    archive,
  });
  assert.equal(result.verified_criteria, 0);
  assert.equal(result.readiness_percent, 0);
});
