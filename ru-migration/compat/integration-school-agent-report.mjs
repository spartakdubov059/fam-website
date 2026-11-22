import assert from 'node:assert/strict';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { createYdbListingsRepository } from '../app/backend/repositories/ydb-listings.mjs';
import { createSchoolAgentReports } from '../app/backend/services/school-agent-reports.mjs';

const driver = new Driver('grpc://127.0.0.1:2136/local');
try {
  await driver.ready();
  const client = query(driver);
  const sql = (strings, ...values) => {
    const statement = client(strings, ...values);
    statement.on('error', () => {});
    return statement;
  };
  sql.begin = client.begin.bind(client);
  const repository = createYdbListingsRepository(sql);
  const refresh = createSchoolAgentReports({
    repository,
    schools: [{ id: 'synthetic-school' }],
    now: () => new Date('2026-11-22T04:10:00.000Z'),
  });

  assert.deepEqual(await refresh(), { refreshed: 1 });
  assert.deepEqual(await refresh(), { refreshed: 1 }, 'the same daily report can be refreshed safely');
  const rows = await sql`SELECT report_date, summary, metrics_json FROM fam_agent_school_daily_reports
    WHERE school_id = 'synthetic-school' AND report_date = '2026-11-22';`;
  const report = rows?.[0]?.[0];
  assert.equal(report?.report_date, '2026-11-22');
  assert.match(report?.summary ?? '', /FAM — сводка за 2026-11-22/);
  const metrics = JSON.parse(report.metrics_json);
  assert.ok(Number.isSafeInteger(metrics.listings.active));
  assert.ok(Number.isSafeInteger(metrics.agent_proposals.pending));
  const ideas = await sql`SELECT COUNT(*) AS count FROM fam_agent_ideas
    WHERE school_id = 'synthetic-school' AND report_date = '2026-11-22';`;
  assert.ok(Number.isSafeInteger(Number(ideas?.[0]?.[0]?.count)));
  console.log('YDB_SYNTHETIC_SCHOOL_AGENT_REPORT_PASS');
} finally {
  await driver.close();
}
