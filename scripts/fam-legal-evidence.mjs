import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/i;
const ENTRY_SHA = /^[0-9a-f]{64}$/;
const SCOPES = new Set(["FAM_CURRENT", "FAM_RU"]);
const OFFICIAL_HOSTS = new Set(["pravo.gov.ru", "publication.pravo.gov.ru"]);
const CRITERIA = new Set([
  "official_source_review",
  "scope_applicability_review",
  "student_data_minimization_review",
  "access_control_review",
  "qualified_counsel_review",
]);
const ENTRY_STATUSES = new Set([
  "source_checked", "change_detected", "source_unavailable",
  "operator_reviewed", "counsel_reviewed", "not_applicable",
]);
const DECISIONS = new Set(["pending_human_review", "confirmed", "rejected", "not_applicable"]);
const PRIORITIES = new Set(["unassessed", "advisory", "significant", "critical"]);
const APPLICABILITY = new Set(["applicable", "not_applicable", "unknown"]);
const REASONS = new Set(["scope_declared", "no_relevant_data", "outside_release_scope", "undetermined"]);

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() ===
    (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function hasTrustedHumanDecision(entry, verifier) {
  if (typeof verifier !== "function") return false;
  try { return verifier(entry) === true; } catch { return false; }
}

function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && OFFICIAL_HOSTS.has(url.hostname.toLowerCase()) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function canonicalEntry(input, previousEntryHash) {
  return {
    schema_version: 1,
    scope: input.scope,
    revision: input.revision,
    criterion_id: input.criterion_id,
    source_url: input.source_url,
    checked_at: input.checked_at,
    status: input.status,
    priority: input.priority,
    decision: input.decision,
    previous_entry_hash: previousEntryHash,
  };
}

export function verifyLegalArchive(archive = []) {
  if (!Array.isArray(archive) || archive.length > 20_000) return false;
  let previous = null;
  for (const entry of archive) {
    const allowedKeys = ["schema_version", "scope", "revision", "criterion_id", "source_url", "checked_at",
      "status", "priority", "decision", "previous_entry_hash", "entry_hash"];
    if (!entry || Object.keys(entry).length !== allowedKeys.length || Object.keys(entry).some((key) => !allowedKeys.includes(key)) ||
        entry.schema_version !== 1 || !SCOPES.has(entry.scope) ||
        !SHA.test(entry.revision || "") || !CRITERIA.has(entry.criterion_id) ||
        !safeSourceUrl(entry.source_url) || !validTimestamp(entry.checked_at) ||
        !ENTRY_STATUSES.has(entry.status) || !PRIORITIES.has(entry.priority) ||
        !DECISIONS.has(entry.decision) || entry.previous_entry_hash !== previous ||
        !ENTRY_SHA.test(entry.entry_hash || "")) return false;
    const supplied = entry.entry_hash;
    const body = canonicalEntry(entry, entry.previous_entry_hash);
    if (hash(body) !== supplied) return false;
    previous = supplied;
  }
  return true;
}

// Returns a new snapshot. The hash chain detects accidental edits but does not
// authenticate an operator/counsel identity or authorize any release action.
export function appendLegalArchiveEntry(archive = [], input = {}) {
  if (!verifyLegalArchive(archive)) throw new Error("Legal archive integrity check failed.");
  const expected = new Set([
    "scope", "revision", "criterion_id", "source_url", "checked_at", "status", "priority", "decision",
  ]);
  if (!input || Object.keys(input).some((key) => !expected.has(key)) || Object.keys(input).length !== expected.size) {
    throw new Error("Legal archive entry has unknown or missing fields.");
  }
  if (!SCOPES.has(input.scope) || !SHA.test(input.revision || "") || !CRITERIA.has(input.criterion_id) ||
      !safeSourceUrl(input.source_url) || !validTimestamp(input.checked_at) ||
      !ENTRY_STATUSES.has(input.status) || !PRIORITIES.has(input.priority) || !DECISIONS.has(input.decision)) {
    throw new Error("Legal archive entry is invalid.");
  }
  if ((input.status === "not_applicable" && (input.decision !== "not_applicable" || input.priority !== "unassessed")) ||
      (input.status === "source_unavailable" && input.decision === "confirmed")) {
    throw new Error("Legal archive status and decision do not match.");
  }
  if ((input.status === "counsel_reviewed") !== (input.criterion_id === "qualified_counsel_review" && input.decision === "confirmed")) {
    if (input.status === "counsel_reviewed" || input.criterion_id === "qualified_counsel_review" && input.decision === "confirmed") {
      throw new Error("Qualified counsel evidence must match the counsel criterion.");
    }
  }
  const body = canonicalEntry(input, archive.at(-1)?.entry_hash || null);
  const entry = Object.freeze({ ...body, entry_hash: hash(body) });
  if (archive.some((existing) => existing.entry_hash === entry.entry_hash ||
      ["scope", "revision", "criterion_id", "source_url", "checked_at", "status", "priority", "decision"]
        .every((key) => existing[key] === input[key]))) return archive;
  return Object.freeze([...archive, entry]);
}

function latestArchiveEntry(archive, predicate) {
  let latest = null;
  for (const entry of archive) {
    if (predicate(entry)) latest = entry;
  }
  return latest;
}

export function evaluateLegalReadiness({ scope, revision, criteria = [], archive = [], verifyHumanDecision } = {}) {
  if (!SCOPES.has(scope) || !SHA.test(revision || "") || !verifyLegalArchive(archive) ||
      !Array.isArray(criteria) || criteria.length > CRITERIA.size) {
    throw new Error("Legal readiness input is invalid.");
  }
  const seen = new Set();
  const applicable = [];
  let unresolvedApplicability = false;
  const pendingApplicability = [];
  for (const criterion of criteria) {
    if (!criterion || Object.keys(criterion).some((key) => !["criterion_id", "applicability", "reason"].includes(key)) ||
        !CRITERIA.has(criterion.criterion_id) || !APPLICABILITY.has(criterion.applicability) ||
        !REASONS.has(criterion.reason) || seen.has(criterion.criterion_id)) {
      throw new Error("Legal readiness criterion is invalid.");
    }
    seen.add(criterion.criterion_id);
    const reasonMatches = criterion.applicability === "applicable"
      ? criterion.reason === "scope_declared"
      : criterion.applicability === "not_applicable"
        ? ["no_relevant_data", "outside_release_scope"].includes(criterion.reason)
        : criterion.reason === "undetermined";
    if (!reasonMatches) throw new Error("Legal criterion reason does not match applicability.");
    if (criterion.applicability === "unknown") {
      unresolvedApplicability = true;
      pendingApplicability.push(criterion.criterion_id);
    }
    const latestEvidence = latestArchiveEntry(archive, (entry) =>
      entry.scope === scope && entry.revision === revision && entry.criterion_id === criterion.criterion_id);
    if (criterion.applicability === "not_applicable" && !(latestEvidence?.status === "not_applicable" &&
        latestEvidence.decision === "not_applicable" && hasTrustedHumanDecision(latestEvidence, verifyHumanDecision))) {
      unresolvedApplicability = true;
      pendingApplicability.push(criterion.criterion_id);
    }
    if (criterion.applicability === "applicable") applicable.push(criterion);
  }

  const missingCriteria = [...CRITERIA].filter((criterionId) => !seen.has(criterionId));
  if (missingCriteria.length || unresolvedApplicability) {
    return Object.freeze({ scope, revision, status: "not_assessed", readiness_percent: null,
      applicable_criteria: null, verified_criteria: 0,
      pending_criteria: Object.freeze([...new Set([...missingCriteria, ...pendingApplicability])]),
      release_gate: "not_authorized_by_legal_evidence",
      authority: "evidence_summary_only; legal opinion and release approval are not provided" });
  }

  const pending = [];
  let verified = 0;
  for (const criterion of applicable) {
    const evidence = latestArchiveEntry(archive, (entry) =>
      entry.scope === scope && entry.revision === revision && entry.criterion_id === criterion.criterion_id);
    const confirmed = evidence?.decision === "confirmed" && hasTrustedHumanDecision(evidence, verifyHumanDecision) &&
      ((criterion.criterion_id === "qualified_counsel_review" && evidence.status === "counsel_reviewed") ||
       (criterion.criterion_id !== "qualified_counsel_review" && evidence.status === "operator_reviewed"));
    if (confirmed) verified++;
    else pending.push(criterion.criterion_id);
  }
  const total = applicable.length;
  const percent = total ? Math.round(verified * 100 / total) : null;
  return Object.freeze({
    scope, revision,
    status: total === 0 ? "not_assessed" : pending.length ? "evidence_pending_human_review" : "criteria_evidenced_pending_release_decision",
    readiness_percent: percent,
    applicable_criteria: total,
    verified_criteria: verified,
    pending_criteria: Object.freeze(pending),
    release_gate: "not_authorized_by_legal_evidence",
    authority: "evidence_summary_only; legal opinion and release approval are not provided",
  });
}

export function scopesForLegalAssessment(scope) {
  if (scope === "FAM_CURRENT" || scope === "FAM_RU") return [scope];
  if (scope === "SHARED") return ["FAM_CURRENT", "FAM_RU"];
  throw new Error("Legal assessment requires an explicit product scope.");
}
