import { createHash } from 'node:crypto';

const RULES = [
  { key: 'safety_review', title: 'Проверить сигналы безопасности', path: 'safety.unreviewed', summary: n => `Есть ${n} непроверенных обезличенных сигналов безопасности. Просмотрите категории и при серьёзных случаях подключите ответственного взрослого. Сигнал не доказывает нарушение.`, benefit: 'Помогает вовремя замечать повторные сигналы и передавать серьёзные ситуации ответственному взрослому.', evidence: n => `Агрегированная сводка школы: непроверенных сигналов ${n}.`, proposedBy: 'fam_safety_analyst' },
  { key: 'council_ideas_review', title: 'Разобрать идеи учеников', path: 'ideas.awaiting_council', summary: n => `В очереди Совета ожидают рассмотрения ${n} предложений. Просмотрите их в панели Совета и отметьте дальнейший статус.`, benefit: 'Помогает не оставлять предложения без обратной связи.', evidence: n => `В очереди Совета находится ${n} новых идей.`, proposedBy: 'fam_council_analyst' },
  { key: 'deletion_requests_review', title: 'Проверить обращения участников', path: 'account_requests.deletion_pending', summary: n => `Есть ${n} открытых запросов на рассмотрение аккаунтов. Проверьте их по школьной процедуре.`, benefit: 'Помогает не оставлять обращения без ответа; решение остаётся за администратором.', evidence: n => `Открытых обращений на рассмотрение: ${n}.`, proposedBy: 'fam_operations_analyst' },
];

export function createSchoolAgentReports({ repository, schools, now = () => new Date() }) {
  if (!repository || !Array.isArray(schools)) throw new TypeError('repository and schools are required');
  return async function refresh() {
    let refreshed = 0;
    for (const school of schools) {
      if (!school?.id) continue;
      const metrics = await repository.getSchoolAgentMetrics(school.id);
      const date = now().toISOString().slice(0, 10);
      const summary = `FAM — сводка за ${date}: активных объявлений ${metrics.listings.active}, новых за сутки ${metrics.listings.new_24h}; непроверенных сигналов безопасности ${metrics.safety.unreviewed}; запросов на удаление ${metrics.account_requests.deletion_pending}; идеи ожидают Совет ${metrics.ideas.awaiting_council}; активных временных ограничений ${metrics.account_requests.active_suspensions}.`;
      await repository.saveSchoolAgentReport({ schoolId: school.id, date, summary, metrics });
      for (const rule of RULES) {
        const count = rule.path.split('.').reduce((value, key) => value?.[key], metrics);
        if (!Number.isInteger(count) || count <= 0) continue;
        const id = createHash('sha256').update(`${school.id}:${date}:${rule.key}`).digest('hex');
        await repository.createSchoolAgentIdea({ id, schoolId: school.id, date, rule, count });
      }
      refreshed++;
    }
    return { refreshed };
  };
}
