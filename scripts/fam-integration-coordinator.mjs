/**
 * FAM Integration Coordinator
 *
 * Deterministic read-only PR integration plan. No secrets, private user data,
 * LLM inference, branch writes, merge, or deploy.
 */

function validNumber(number) {
  return Number.isSafeInteger(number) && number > 0;
}

function sortedUnique(items) {
  return [...new Set(items)].sort((a, b) => a - b);
}

function isProtectedPath(path) {
  return typeof path === "string" &&
    (path.startsWith("supabase/") || path.startsWith(".github/") ||
     path.startsWith("scripts/"));
}

function groupEdges(disputes = []) {
  const adjacency = new Map();
  const edges = [];
  for (const d of disputes) {
    const a = d?.prs?.[0], b = d?.prs?.[1];
    if (!validNumber(a) || !validNumber(b) || a === b ||
        !Array.isArray(d.files) || !d.files.length) continue;
    const files = d.files.filter((x) => typeof x === "string").slice(0, 8);
    if (!files.length) continue;
    for (const n of [a, b]) {
      if (!adjacency.has(n)) adjacency.set(n, new Set());
    }
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
    edges.push({ prs: sortedUnique([a, b]), files,
      highRisk: files.some(isProtectedPath) || d.highRisk === true });
  }
  return { adjacency, edges };
}

/**
 * Returns affected PR clusters and a review sequence, never a merge order.
 * A draft may still need review, but it is never described as merge-ready.
 * Missing file lists produce no evidence of safety.
 */
export function buildIntegrationPlan({ pulls = [], disputes = [], limited = false } = {}) {
  const pullMap = new Map(
    pulls.filter((x) => validNumber(x?.number)).map((x) => [x.number, x])
  );
  const { adjacency, edges } = groupEdges(disputes);
  const seen = new Set();
  const groups = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const stack = [start], nodes = [];
    seen.add(start);
    while (stack.length) {
      const current = stack.pop();
      nodes.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    const numbers = sortedUnique(nodes);
    const memberEdges = edges.filter((e) =>
      numbers.includes(e.prs[0]) && numbers.includes(e.prs[1])
    );
    const files = [...new Set(memberEdges.flatMap((e) => e.files))]
      .sort((a, b) => a.localeCompare(b)).slice(0, 10);
    const highRisk = memberEdges.some((e) => e.highRisk);
    const ready = numbers.filter((n) => pullMap.get(n)?.draft === false);
    const draft = numbers.filter((n) => pullMap.get(n)?.draft === true);
    const unknown = numbers.filter((n) => !pullMap.has(n) ||
      typeof pullMap.get(n).draft !== "boolean");
    const reviewSequence = [...ready, ...draft, ...unknown];
    groups.push({
      prs: numbers,
      conflictCount: memberEdges.length,
      files,
      highRisk,
      draft,
      reviewSequence,
      recommendation: highRisk
        ? "Сначала независимая проверка защищённых файлов и CI. Назначить ответственный PR вручную, остальные пересмотреть относительно него."
        : "Сравнить diff и тесты. Выбрать основной PR вручную, затем обновить остальные ветки относительно проверенного изменения.",
    });
  }
  groups.sort((a, b) =>
    Number(b.highRisk) - Number(a.highRisk) ||
    b.conflictCount - a.conflictCount ||
    b.prs.length - a.prs.length ||
    a.prs[0] - b.prs[0]
  );
  return {
    groups,
    overlapPairs: edges.length,
    examinedPulls: pulls.length,
    limited: Boolean(limited),
  };
}

export function formatIntegrationPlan(plan, maxGroups = 8) {
  const groups = Array.isArray(plan?.groups) ? plan.groups : [];
  if (!groups.length) {
    return "Нет подтверждённых пересечений файлов между проверенными PR. Это не гарантирует отсутствие логических конфликтов.";
  }
  const lines = [
    "Кластеров пересекающихся изменений: " + groups.length +
      "; пар PR с пересечением: " + (Number(plan?.overlapPairs) || 0) + ".",
    "Указана **очередь проверки**, а не разрешение или порядок автоматического merge.",
  ];
  for (const group of groups.slice(0, maxGroups)) {
    lines.push("- **" + (group.highRisk ? "Высокий риск" : "Обычный риск") + "** — PR " +
      group.prs.map((n) => "#" + n).join(", ") +
      "; пересекающихся пар: " + group.conflictCount +
      "; очередь проверки: " + group.reviewSequence.map((n) => "#" + n).join(" → ") +
      (group.draft.length ? "; черновики: " + group.draft.map((n) => "#" + n).join(", ") : "") +
      "; общие файлы: " + group.files.map((f) => escapeMarkdown(f)).join(", ") +
      ". " + group.recommendation);
  }
  if (groups.length > maxGroups) {
    lines.push("- Ещё групп: " + (groups.length - maxGroups) + "; требуется отдельная проверка.");
  }
  if (plan?.limited) {
    lines.push("- Выборка PR или списков файлов неполная; приоритеты предварительные.");
  }
  return lines.join("\n");
}

function escapeMarkdown(value) {
  return String(value).replace(/[\r\n\t\u0000-\u001f]/g, " ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[|"'\[\]()*_~#]/g, (ch) => "&#" + ch.charCodeAt(0) + ";")
    .slice(0, 150);
}
