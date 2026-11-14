const ALLOWED_PATH = /^(?:index\.html|(?:css|js|assets|docs|tests)\/[A-Za-z0-9._/-]+)$/;
const REQUIRED_PLAN_FIELDS = [
  "finding_status",
  "problem_summary",
  "root_cause",
  "evidence",
  "files",
  "keywords",
  "plan",
];

function normalizeEvidence(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeRisk(value) {
  if (["low", "medium", "high"].includes(value)) return value;
  const hints = [
    ...(Array.isArray(value?.risks) ? value.risks : []),
    typeof value?.risk === "string" ? value.risk : "",
  ].join(" ").toLowerCase();
  if (/\b(high|critical|severe)\b/.test(hints)) return "high";
  if (/\b(medium|moderate)\b/.test(hints)) return "medium";
  if (/\blow\b/.test(hints)) return "low";
  return "high";
}

function isAllowedTrackedPath(path, trackedPaths) {
  return typeof path === "string" && ALLOWED_PATH.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..") &&
    trackedPaths.includes(path);
}

export function normalizePlannerResponse(value, { explicitPaths = [], trackedPaths = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const missing = REQUIRED_PLAN_FIELDS.filter((field) =>
    !Object.prototype.hasOwnProperty.call(value, field)
  );
  if (missing.length === 0) return value;

  const patch = typeof value.unified_diff === "string" ? value.unified_diff.trim() : "";
  if (value.finding_status !== "issue_found" || !patch) return null;

  const candidates = Array.isArray(value.files)
    ? [...new Set(value.files)]
    : Array.isArray(value.affected_files)
      ? [...new Set(value.affected_files)]
      : [...new Set(explicitPaths)];
  if (candidates.length !== 1 || !isAllowedTrackedPath(candidates[0], trackedPaths)) return null;

  const evidence = normalizeEvidence(value.evidence);
  if (evidence.length === 0) return null;

  const problemSummary = typeof value.problem_summary === "string" && value.problem_summary.trim()
    ? value.problem_summary.trim()
    : typeof value.summary === "string" && value.summary.trim()
      ? value.summary.trim()
      : "Модель указала воспроизводимую проблему.";
  const proposedChange = typeof value.proposed_change === "string" && value.proposed_change.trim()
    ? value.proposed_change.trim()
    : typeof value.plan === "string" && value.plan.trim()
      ? value.plan.trim()
      : problemSummary;
  const tests = Array.isArray(value.tests)
    ? value.tests.filter((item) => typeof item === "string")
    : Array.isArray(value.tests_to_run)
      ? value.tests_to_run.filter((item) => typeof item === "string")
      : [];

  return {
    ...value,
    finding_status: "issue_found",
    problem_summary: problemSummary,
    root_cause: typeof value.root_cause === "string" ? value.root_cause : "",
    evidence,
    files: candidates,
    keywords: Array.isArray(value.keywords)
      ? value.keywords.filter((item) => typeof item === "string").slice(0, 18)
      : [],
    plan: proposedChange,
    unified_diff: patch,
    summary: typeof value.summary === "string" ? value.summary : problemSummary,
    proposed_change: proposedChange,
    risk: normalizeRisk(value),
    requires_approval: true,
    tests,
  };
}
