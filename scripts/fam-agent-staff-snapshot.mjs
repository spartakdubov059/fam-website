const STAFF = Object.freeze([
  ["arbiter", "Босс (ARBITER)"],
  ["inspector", "Проверяющий (INSPECTOR)"],
  ["legal", "Юрист (LEGAL)"],
  ["qwen", "Разработчик (Qwen)"],
  ["qa", "Испытатель (QA)"],
  ["integrator", "Связной (INTEGRATOR)"],
  ["recruiter", "Советник штаба (RECRUITER)"],
  ["moderator", "Надзиратель (MODERATOR)"],
  ["development_advisor", "Советник по развитию"],
]);

const VALID_STATES = new Set(["confirmed", "checked_no_signal", "no_data"]);

function safeText(value, limit = 240) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, limit)
    .replace(/[&<>"'|*_~#\[\]()`]/g, (ch) => "&#" + ch.charCodeAt(0) + ";");
}

export function buildStaffSnapshot(signals = {}) {
  return STAFF.map(([key, name]) => {
    const raw = signals[key];
    const state = raw && VALID_STATES.has(raw.state) ? raw.state : "no_data";
    const evidenceCount = Number.isSafeInteger(raw?.evidence_count) && raw.evidence_count >= 0
      ? Math.min(raw.evidence_count, 10_000_000)
      : 0;
    const detail = safeText(raw?.detail);
    return Object.freeze({
      key,
      name,
      state,
      evidence_count: evidenceCount,
      detail: detail || (state === "no_data" ? "Подтверждённый источник результатов не подключён." : ""),
    });
  });
}

export function renderStaffSnapshot(signals = {}) {
  const rows = buildStaffSnapshot(signals);
  const stateLabel = {
    confirmed: "есть подтверждённые события",
    checked_no_signal: "проверен, новых сигналов нет",
    no_data: "нет подтверждённых данных",
  };
  return [
    "## Девять сотрудников штаба — подтверждённый срез",
    "Статусы отражают только доступные источники; отсутствие данных не считается успехом или бездействием.",
    ...rows.map((row) => "- **" + row.name + "** — " + stateLabel[row.state] +
      (row.evidence_count ? "; событий: " + row.evidence_count : "") +
      (row.detail ? "; " + row.detail : "")),
  ].join("\n");
}
