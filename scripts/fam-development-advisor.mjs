const MAX_ROWS = 14;
const REQUIRED_DAYS = 6;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const LISTING_BANDS = new Set(["none", "suppressed", "5_9", "10_24", "25_plus"]);
const LISTING_BAND_RANK = Object.freeze({ none: 0, suppressed: 1, "5_9": 2, "10_24": 3, "25_plus": 4 });

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return [];
  const safe = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || !validDate(row.report_date) || seen.has(row.report_date) ||
        !LISTING_BANDS.has(row.active_listings_band) ||
        !LISTING_BANDS.has(row.new_listings_24h_band) ||
        typeof row.generated_at !== "string" || !Number.isFinite(Date.parse(row.generated_at))) continue;
    seen.add(row.report_date);
    safe.push({
      report_date: row.report_date,
      generated_at: new Date(row.generated_at).toISOString(),
      active_listings_band: row.active_listings_band,
      new_listings_24h_band: row.new_listings_24h_band,
    });
  }
  return safe.sort((a, b) => b.report_date.localeCompare(a.report_date)).slice(0, MAX_ROWS);
}

const averageRank = (rows, key) => rows.reduce((sum, row) => sum + LISTING_BAND_RANK[row[key]], 0) / rows.length;

export function buildDevelopmentAdvisor(rows = [], { now = Date.now() } = {}) {
  const snapshots = validateRows(rows);
  const empty = (reason) => Object.freeze({
    state: "no_data", reason, snapshot_count: snapshots.length,
    latest_report_date: snapshots[0]?.report_date || null,
    proposals: Object.freeze([]),
  });
  if (snapshots.length < REQUIRED_DAYS) return empty("insufficient_history");

  const newestMs = Date.parse(snapshots[0].generated_at);
  if (newestMs > now + 5 * 60_000 || now - newestMs > MAX_AGE_MS) return empty("stale_snapshot");
  for (let index = 1; index < REQUIRED_DAYS; index++) {
    const expectedPrevious = new Date(Date.parse(snapshots[index - 1].report_date + "T00:00:00Z") - 86_400_000)
      .toISOString().slice(0, 10);
    if (snapshots[index].report_date !== expectedPrevious) return empty("gapped_history");
  }

  const recent = snapshots.slice(0, 3);
  const previous = snapshots.slice(3, 6);
  const previousActive = averageRank(previous, "active_listings_band");
  const recentActive = averageRank(recent, "active_listings_band");
  const previousNew = averageRank(previous, "new_listings_24h_band");
  const recentNew = averageRank(recent, "new_listings_24h_band");
  const activeDrop = previousActive >= 3 && recentActive <= previousActive - 0.75;
  const newListingDrop = previousNew >= 2 && recentNew === 0;
  const proposals = activeDrop || newListingDrop ? [Object.freeze({
    key: "review_listing_discovery",
    scope: "FAM_CURRENT",
    title: "Проверить, насколько заметен и понятен раздел объявлений",
    evidence: Object.freeze({
      snapshots: REQUIRED_DAYS,
      previous_active_listings_bands: [...new Set(previous.map((row) => row.active_listings_band))],
      recent_active_listings_bands: [...new Set(recent.map((row) => row.active_listings_band))],
      previous_new_listings_24h_bands: [...new Set(previous.map((row) => row.new_listings_24h_band))],
      recent_new_listings_24h_bands: [...new Set(recent.map((row) => row.new_listings_24h_band))],
      privacy_threshold: "точные показатели меньше пяти скрываются; остальные передаются диапазонами",
    }),
    hypothesis: "Снижение агрегатов может быть связано с заметностью или понятностью раздела; причина этими счётчиками не устанавливается.",
    next_step: "Предложить владельцу проверку сценария просмотра и добавления объявления; не менять продукт автоматически.",
    design_brief: Object.freeze({
      status: "proposal_only",
      user_scenario: "Ученик с действующей сессией хочет быстро найти объявления и понять, как посмотреть детали или добавить своё.",
      options: Object.freeze([
        "Проверить заметность входа в раздел на мобильном и настольном экране.",
        "Проверить пустое состояние, загрузку и ошибку: понятно ли, что происходит и какой безопасный следующий шаг доступен.",
        "Сравнить текущий сценарий с одним упрощённым макетом до разработки; не менять Auth и роли.",
      ]),
      acceptance_checks: Object.freeze([
        "Синтетический проход на узком и широком экране находит раздел без поиска по странице.",
        "При пустом результате и ошибке видны разные понятные состояния.",
        "Клавиатурный фокус и подписи элементов остаются доступными.",
        "Любое изменение интерфейса проходит независимую QA и отдельное решение владельца.",
      ]),
      risks: Object.freeze([
        "Счётчики не объясняют причину снижения и не подтверждают проблемы интерфейса.",
        "Нельзя делать выводы о поведении отдельных учеников или малых групп.",
      ]),
      cost: "Только проектная проверка без нового сервиса; трудоёмкость реализации не оценивалась.",
      priority: "advisory",
    }),
    authority: "recommendation_only",
  })] : [];

  return Object.freeze({
    state: proposals.length ? "confirmed" : "checked_no_signal",
    reason: proposals.length ? "aggregate_change_detected" : "no_threshold_crossed",
    snapshot_count: REQUIRED_DAYS,
    latest_report_date: snapshots[0].report_date,
    proposals: Object.freeze(proposals),
  });
}

export function renderDevelopmentAdvisor(result) {
  const labels = {
    confirmed: "есть предложение по проверяемой гипотезе",
    checked_no_signal: "пороговые изменения не обнаружены",
    no_data: "недостаточно свежих агрегированных данных",
  };
  const lines = [
    "## Советник по развитию — агрегированные сигналы",
    "Состояние: " + (labels[result?.state] || labels.no_data) + ".",
  ];
  if (result?.latest_report_date) lines.push("Последняя сводка: " + result.latest_report_date + "; дней в проверке: " + result.snapshot_count + ".");
  if (!result?.proposals?.length) {
    lines.push("Регистрации и использование отдельных функций не анализировались: подтверждённый источник этих агрегатов не подключён.");
  }
  for (const proposal of result?.proposals || []) {
    lines.push(
      "- **" + proposal.title + "** (гипотеза, не установленная причина). " + proposal.hypothesis,
      "  Диапазоны объявлений: активные — " + proposal.evidence.previous_active_listings_bands.join(", ") +
        " → " + proposal.evidence.recent_active_listings_bands.join(", ") +
        "; новые за сутки — " + proposal.evidence.previous_new_listings_24h_bands.join(", ") +
        " → " + proposal.evidence.recent_new_listings_24h_bands.join(", ") +
        "; " + proposal.evidence.privacy_threshold + ".",
      "  Следующий шаг: " + proposal.next_step,
      "  UX-задание: " + proposal.design_brief.options.join(" "),
      "  Критерии: " + proposal.design_brief.acceptance_checks.join(" "),
      "  Риски: " + proposal.design_brief.risks.join(" "),
    );
  }
  lines.push("Используются только дневные счётчики объявлений. Нет доступа к профилям, регистрациям, перепискам или содержимому учеников; Советник только рекомендует и не создаёт задачи автоматически.");
  return lines.join("\n");
}
