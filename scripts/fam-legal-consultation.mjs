const SHA = /^[0-9a-f]{40}$/i;
const BRANCH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SCOPES = new Set(["FAM_CURRENT", "FAM_RU", "SHARED"]);
const TASK_RISK_TOPICS = Object.freeze({
  audit_frontend_runtime: Object.freeze([]),
  audit_client_resilience: Object.freeze(["external_processing"]),
  audit_accessibility: Object.freeze([]),
  audit_agent_infrastructure: Object.freeze(["access_control", "external_processing"]),
});
const FEATURE_KEYS = new Set([
  "announcements",
  "student_marketplace",
  "media_upload",
  "content_moderation",
  "agent_coordination",
  "custom_feature",
]);
const FEATURE_RISK_FLAGS = Object.freeze({
  handles_student_data: "student_data_handling",
  uses_private_media: "file_and_media_handling",
  adds_external_provider: "external_processing",
  changes_access_control: "access_control",
  changes_moderation: "content_moderation",
  adds_persistent_storage: "database_change",
});
const FEATURE_QA_CHECKS = Object.freeze({
  student_data_handling: "Подтвердить, что используются только необходимые поля; проверить отсутствие персональных данных в моделях, логах и артефактах на синтетических примерах.",
  file_and_media_handling: "Проверить закрытый доступ к файлам, принадлежность объекта и истечение временных ссылок.",
  external_processing: "Проверить, что внешний получатель, передаваемые поля и условия хранения перечислены; без согласования сетевой вызов не выполнять.",
  access_control: "Проверить матрицу ролей, отрицательные сценарии и отсутствие непредусмотренного расширения Auth/RLS.",
  content_moderation: "Сравнить синтетические безопасные и запрещённые примеры; подтвердить, что правила модерации не ослаблены.",
  database_change: "Проверить одноразовое применение, откат, повторное применение и сохранность данных на пустой изолированной базе.",
});

const RISK_OPTIONS = Object.freeze({
  access_control: Object.freeze({
    recommendation: "Сохранить действующие серверные проверки; сузить изменение до необходимого доступа.",
    alternatives: Object.freeze([
      "Оставить текущую политику и добавить тесты отказа для неразрешённых ролей.",
      "Если изменение обязательно, изменить только нужное правило и приложить матрицу ролей и сценарии отказа.",
    ]),
    qa: "Проверить разрешённые и запрещённые роли на чтение и изменение; доказать, что доступ не расширился случайно.",
  }),
  content_moderation: Object.freeze({
    recommendation: "Сохранить все действующие защитные проверки и не ослаблять правила модерации.",
    alternatives: Object.freeze([
      "Исправить ошибку в обработке после модерации без изменения порогов и правил.",
      "Если меняется логика проверки, сравнить синтетические безопасные и запрещённые примеры независимым QA.",
    ]),
    qa: "Проверить сохранение обнаружения травли, угроз и запрещённых контактов; не использовать реальные сообщения учеников.",
  }),
  student_data_handling: Object.freeze({
    recommendation: "Не собирать дополнительные сведения; исключить пользовательские данные из prompt, логов и артефактов.",
    alternatives: Object.freeze([
      "Использовать только синтетический пример или подтверждённый агрегат.",
      "Если данные необходимы функции, сначала описать минимальный набор полей и получить проверку ответственного оператора.",
    ]),
    qa: "Проверить отсутствие ФИО, контактов и иных пользовательских данных в запросах, логах и тестовых артефактах.",
  }),
  file_and_media_handling: Object.freeze({
    recommendation: "Сохранить закрытый доступ к файлам и выдавать только временный доступ по действующим правилам.",
    alternatives: Object.freeze([
      "Передавать проверяющему безопасный идентификатор или агрегат вместо ссылки на файл.",
      "Если нужен файл, оставить хранилище закрытым и ограничить доступ конкретной операцией.",
    ]),
    qa: "Проверить закрытый bucket, срок действия ссылок и запрет постоянных URL в журналах.",
  }),
  external_processing: Object.freeze({
    recommendation: "Предпочесть локальную обработку; не отправлять данные внешнему сервису без отдельной проверки и решения владельца.",
    alternatives: Object.freeze([
      "Выполнить обработку локально на существующей бесплатной инфраструктуре.",
      "Если внешний сервис необходим, сначала описать данные, цель, хранение и получателя; решение остаётся за оператором.",
    ]),
    qa: "Проверить список полей, сетевые адреса, журналы, срок хранения и отсутствие секретов до любого разрешённого вызова.",
  }),
  database_change: Object.freeze({
    recommendation: "Не применять миграцию автоматически; подготовить изолированный прогон, проверенный откат и сохранение журнала.",
    alternatives: Object.freeze([
      "Оставить схему без изменений и решить задачу в существующем контракте.",
      "Если миграция нужна, добавить узкую миграцию с одноразовым тестом прямого применения, отката и повторного применения.",
    ]),
    qa: "Проверить права RPC, отрицательные переходы, повторные вызовы, сохранность строк и журналов.",
  }),
});

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

function validBranchRef(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 ||
      value.startsWith("/") || value.endsWith("/") || value.includes("//") ||
      value.includes("..") || value.includes("@{") || /[~^:?*[\\\x00-\x20\x7f]/.test(value)) return false;
  return value.split("/").every((part) => BRANCH_COMPONENT.test(part) && !part.endsWith(".lock"));
}

function assessPlannedFeature(feature, { scope, branch, revision, versionScopes }) {
  if (feature === undefined || feature === null) return null;
  if (!feature || typeof feature !== "object" || Array.isArray(feature) ||
      Object.keys(feature).sort().join(",") !== "featureKey,riskFlags") {
    throw new Error("Planned feature must contain only an allowlisted feature key and fixed risk flags.");
  }
  if (!FEATURE_KEYS.has(feature.featureKey)) {
    throw new Error("Planned feature key is not allowlisted.");
  }
  if (!feature.riskFlags || typeof feature.riskFlags !== "object" || Array.isArray(feature.riskFlags) ||
      Object.keys(feature.riskFlags).sort().join(",") !== Object.keys(FEATURE_RISK_FLAGS).sort().join(",")) {
    throw new Error("Planned feature must provide every fixed risk flag.");
  }
  for (const value of Object.values(feature.riskFlags)) {
    if (typeof value !== "boolean") throw new Error("Planned feature risk flags must be boolean.");
  }
  const riskCategories = [...new Set(Object.entries(FEATURE_RISK_FLAGS)
    .filter(([flag]) => feature.riskFlags[flag])
    .map(([, category]) => category))].sort();
  const scopeAssessments = versionScopes.map((versionScope) => Object.freeze({
    scope: versionScope,
    status: "human_review_pending",
    release_gate: "feature_review_pending_for_affected_scope",
    applicable_criteria: null,
    verified_criteria: 0,
    readiness_percent: null,
  }));
  return Object.freeze({
    status: "preliminary_technical_risk_screen_only",
    feature_key: feature.featureKey,
    scope,
    branch,
    revision,
    risk_categories: riskCategories,
    risk_flags: Object.freeze({ ...feature.riskFlags }),
    scope_assessments: scopeAssessments,
    qa_acceptance_checks: riskCategories.map((category) => FEATURE_QA_CHECKS[category]),
    legal_opinion: false,
    release_authority: false,
    independent_human_review: "pending_human_review",
    source_verification: "not_performed",
  });
}

export function buildLegalConsultation({ scope, branch, revision, changedFiles = [], taskKey, plannedFeature } = {}) {
  if (!SCOPES.has(scope)) throw new Error("Legal consultation requires an explicit product scope.");
  if (!validBranchRef(branch)) throw new Error("Legal consultation requires an exact safe branch ref.");
  if (typeof revision !== "string" || !SHA.test(revision)) {
    throw new Error("Legal consultation requires an exact 40-character revision.");
  }
  if (!Array.isArray(changedFiles) || changedFiles.length > 200 ||
      changedFiles.some((path) => typeof path !== "string" || path.length > 240 || path.startsWith("/") || path.includes(".."))) {
    throw new Error("Invalid changed-file evidence.");
  }
  if (taskKey !== undefined && !Object.hasOwn(TASK_RISK_TOPICS, taskKey)) {
    throw new Error("Legal consultation requires an allowlisted task key.");
  }

  const riskCounts = new Map();
  for (const risk of taskKey ? TASK_RISK_TOPICS[taskKey] : []) {
    riskCounts.set(risk, (riskCounts.get(risk) || 0) + 1);
  }
  for (const path of changedFiles) {
    for (const risk of classifyPath(path)) riskCounts.set(risk, (riskCounts.get(risk) || 0) + 1);
  }
  if (plannedFeature !== undefined && plannedFeature !== null) {
    const featureKeys = plannedFeature && typeof plannedFeature === "object" &&
      !Array.isArray(plannedFeature) && plannedFeature.riskFlags &&
      typeof plannedFeature.riskFlags === "object" && !Array.isArray(plannedFeature.riskFlags)
      ? Object.entries(FEATURE_RISK_FLAGS).filter(([flag]) => plannedFeature.riskFlags[flag] === true)
      : [];
    for (const [, category] of featureKeys) riskCounts.set(category, (riskCounts.get(category) || 0) + 1);
  }
  const riskCategories = [...riskCounts.keys()].sort();
  const versionScopes = scope === "SHARED" ? ["FAM_CURRENT", "FAM_RU"] : [scope];
  const featureAssessment = assessPlannedFeature(plannedFeature, { scope, branch, revision, versionScopes });
  const reviewRequired = riskCategories.length > 0 || scope !== "FAM_CURRENT" || featureAssessment !== null;
  const checks = [
    "Проверить минимизацию данных и отсутствие персональных данных школьников в запросах и журналах.",
    "Не менять Auth, RLS, роли и модерацию без отдельного обоснования и независимой проверки.",
    "Не подключать платные или внешние сервисы без отдельного согласования.",
    "QA должна проверить заявленные границы, отрицательные сценарии и отсутствие обхода ограничений.",
  ];
  if (scope === "FAM_RU" || scope === "SHARED") {
    checks.push("Для FAM_RU отдельно проверить доказательства миграции; этот статус не блокирует несвязанные безопасные изменения FAM_CURRENT.");
  }

  const scopeAssessments = versionScopes.map((versionScope) => {
    const ruEvidencePending = versionScope === "FAM_RU";
    const pathReviewPending = riskCategories.length > 0 || featureAssessment !== null;
    return Object.freeze({
      scope: versionScope,
      status: pathReviewPending || ruEvidencePending ? "human_review_pending" : "not_assessed",
      applicable_criteria: null,
      verified_criteria: 0,
      readiness_percent: null,
      release_gate: featureAssessment ? "feature_review_pending_for_affected_scope" :
        pathReviewPending ? "review_required_for_affected_scope" :
        ruEvidencePending ? "migration_evidence_pending_for_ru_only" : "no_path_trigger_detected_not_approval",
    });
  });
  const riskOptions = riskCategories.map((category) => Object.freeze({
    category,
    signal_status: taskKey && TASK_RISK_TOPICS[taskKey].includes(category)
      ? "allowlisted_task_scope_signal" : "declared_path_signal",
    priority: "unassessed",
    source_status: "not_verified",
    recommendation: RISK_OPTIONS[category].recommendation,
    alternatives: RISK_OPTIONS[category].alternatives,
    qa_acceptance_check: RISK_OPTIONS[category].qa,
  }));

  return Object.freeze({
    schema_version: 1,
    role: "LEGAL",
    scope,
    branch,
    version_scopes: versionScopes,
    revision,
    risk_categories: riskCategories,
    provisional_priority: "advisory",
    priority_basis: "Правовые источники и применимость к этой ревизии не проверялись; тип задачи и пути дают только технические сигналы.",
    status: reviewRequired ? "advisory_review_pending" : "no_trigger_detected_not_legal_approval",
    human_review_required: reviewRequired,
    legal_opinion: false,
    release_authority: false,
    source_verification: { status: "not_performed", sources: [], checked_at: null },
    unresolved_questions: [
      "Какие действующие редакции официальных актов применимы к затронутой функции и контуру?",
      "Подтвердили ли вывод ответственный оператор и, если требуется, квалифицированный юрист?",
    ],
    scope_assessments: scopeAssessments,
    planned_feature_assessment: featureAssessment,
    independent_review: reviewRequired ? "pending_human_review" : "not_triggered_by_path_signal",
    evidence: {
      changed_file_count: changedFiles.length,
      task_key: taskKey ?? null,
      signal_source: taskKey ? "allowlisted_task_scope_and_declared_paths" : "declared_paths",
      risk_counts: Object.fromEntries([...riskCounts].sort(([a], [b]) => a.localeCompare(b))),
    },
    risk_options: riskOptions,
    qwen_guidance: {
      goal: "Учитывать перечисленные технические риски и не выходить за согласованный scope.",
      restrictions: ["Не включать реальные данные школьников или секреты.", "Не менять Auth, RLS, роли или production-модерацию без отдельного согласования."],
      qa_acceptance_checks: checks,
      alternatives: riskOptions,
      planned_feature_assessment: featureAssessment,
      human_decision_required_before_release: reviewRequired,
    },
  });
}
