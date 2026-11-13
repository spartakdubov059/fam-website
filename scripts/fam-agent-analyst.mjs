const ALLOWED_AREAS = new Set(["auth", "listings", "notifications", "database", "other"]);

const SIGNAL_RULES = {
  js_runtime: {
    group: "runtime",
    title: "Ошибки выполнения JavaScript",
    hypothesis: "Клиентский JavaScript завершался исключениями; точная причина не содержится в агрегате.",
    recommended_check: "Проверить соответствующие участки клиентского кода и regression-тесты.",
  },
  unhandled_rejection: {
    group: "runtime",
    title: "Необработанные асинхронные ошибки",
    hypothesis: "Асинхронная операция могла завершиться без обработки отказа.",
    recommended_check: "Проверить обработчики Promise и отказные сценарии указанного раздела.",
  },
  supabase_sdk_unavailable: {
    group: "client_dependency",
    title: "Supabase SDK недоступен",
    hypothesis: "Клиент не смог загрузить или инициализировать SDK.",
    recommended_check: "Проверить загрузку SDK и конфигурацию клиентского запуска.",
  },
  listings_load_failed: {
    group: "listings",
    title: "Не удалось загрузить объявления",
    hypothesis: "Запрос или отображение объявлений завершились ошибкой.",
    recommended_check: "Проверить путь загрузки объявлений и сетевые отказные сценарии.",
  },
  notifications_load_failed: {
    group: "notifications",
    title: "Не удалось загрузить уведомления",
    hypothesis: "Запрос уведомлений завершился ошибкой.",
    recommended_check: "Проверить путь загрузки и сетевые отказные сценарии.",
  },
  database_request_failed: {
    group: "database",
    title: "Ошибка запроса к базе данных",
    hypothesis: "Клиентский запрос к базе данных завершился ошибкой.",
    recommended_check: "Проверить метрики запросов и сетевые отказные сценарии.",
  },
  auth_backend_failed: {
    group: "auth",
    title: "Ошибка Auth backend",
    hypothesis: "Операция Auth не получила успешный ответ.",
    recommended_check: "Проверить доступность Auth без чтения пользовательских данных.",
  },
};

export function analyzeTechnicalSignals(signals) {
  const groups = new Map();
  for (const signal of Array.isArray(signals) ? signals.slice(0, 100) : []) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) continue;
    const rule = SIGNAL_RULES[signal.event_code];
    if (!rule || !ALLOWED_AREAS.has(signal.page_area)) continue;
    if (!Number.isSafeInteger(signal.occurrences) || signal.occurrences < 1 || signal.occurrences > 1000000) continue;
    const key = rule.group + ":" + signal.page_area;
    const group = groups.get(key) ?? {
      key: rule.group,
      title: rule.title,
      page_area: signal.page_area,
      occurrences: 0,
      event_codes: [],
      hypothesis: rule.hypothesis,
      recommended_check: rule.recommended_check,
    };
    group.occurrences = Math.min(1000000, group.occurrences + signal.occurrences);
    if (!group.event_codes.includes(signal.event_code)) group.event_codes.push(signal.event_code);
    groups.set(key, group);
  }
  const findings = [...groups.values()]
    .map((group) => ({ ...group, event_codes: group.event_codes.sort() }))
    .sort((a, b) => b.occurrences - a.occurrences || a.key.localeCompare(b.key) || a.page_area.localeCompare(b.page_area));
  return {
    status: findings.length ? "hypotheses_available" : "no_allowlisted_signals",
    findings,
    limitations: "Гипотезы основаны только на агрегированных кодах событий; первопричина не подтверждается без дополнительных безопасных доказательств.",
  };
}
