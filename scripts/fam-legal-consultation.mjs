const SHA = /^[0-9a-f]{40}$/i;
const SCOPES = new Set(["FAM_CURRENT", "FAM_RU", "SHARED"]);

function classifyPath(path) {
  const value = String(path).toLowerCase();
  const risks = [];
  if (/auth|rls|policy|role|permission/.test(value)) risks.push("access_control");
  if (/moderation|moderate|safety|report/.test(value)) risks.push("content_moderation");
  if (/student|profile|user-data|personal-data|school/.test(value)) risks.push("student_data_handling");
  if (/storage|upload|image|media/.test(value)) risks.push("file_and_media_handling");
  if (/external|api-client|integration|webhook/.test(value)) risks.push("external_processing");
  if (value.startsWith("supabase/migrations/")) risks.push("database_change");
  return [...new Set(risks)];
}

export function buildLegalConsultation({ scope, revision, changedFiles = [] } = {}) {
  if (!SCOPES.has(scope)) throw new Error("Legal consultation requires an explicit product scope.");
  if (typeof revision !== "string" || !SHA.test(revision)) {
    throw new Error("Legal consultation requires an exact 40-character revision.");
  }
  if (!Array.isArray(changedFiles) || changedFiles.length > 200 ||
      changedFiles.some((path) => typeof path !== "string" || path.length > 240 || path.startsWith("/") || path.includes(".."))) {
    throw new Error("Invalid changed-file evidence.");
  }

  const riskCounts = new Map();
  for (const path of changedFiles) {
    for (const risk of classifyPath(path)) riskCounts.set(risk, (riskCounts.get(risk) || 0) + 1);
  }
  const riskCategories = [...riskCounts.keys()].sort();
  const reviewRequired = riskCategories.length > 0 || scope !== "FAM_CURRENT";
  const versionScopes = scope === "SHARED" ? ["FAM_CURRENT", "FAM_RU"] : [scope];
  const checks = [
    "Проверить минимизацию данных и отсутствие персональных данных школьников в запросах и журналах.",
    "Не менять Auth, RLS, роли и модерацию без отдельного обоснования и независимой проверки.",
    "Не подключать платные или внешние сервисы без отдельного согласования.",
    "QA должна проверить заявленные границы, отрицательные сценарии и отсутствие обхода ограничений.",
  ];
  if (scope === "FAM_RU" || scope === "SHARED") {
    checks.push("Для FAM_RU отдельно проверить доказательства миграции; этот статус не блокирует несвязанные безопасные изменения FAM_CURRENT.");
  }

  return Object.freeze({
    schema_version: 1,
    role: "LEGAL",
    scope,
    version_scopes: versionScopes,
    revision,
    risk_categories: riskCategories,
    status: reviewRequired ? "advisory_review_pending" : "no_trigger_detected_not_legal_approval",
    human_review_required: reviewRequired,
    legal_opinion: false,
    release_authority: false,
    source_verification: "not_performed",
    evidence: { changed_file_count: changedFiles.length, risk_counts: Object.fromEntries([...riskCounts].sort(([a], [b]) => a.localeCompare(b))) },
    qwen_guidance: {
      goal: "Учитывать перечисленные технические риски и не выходить за согласованный scope.",
      restrictions: ["Не включать реальные данные школьников или секреты.", "Не менять Auth, RLS, роли или production-модерацию без отдельного согласования."],
      qa_acceptance_checks: checks,
    },
  });
}
