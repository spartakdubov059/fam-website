import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDevelopmentAdvisor, renderDevelopmentAdvisor } from "../../scripts/fam-development-advisor.mjs";

const migration = readFileSync(new URL("../../supabase/migrations/20261127050000_fam_development_advisor_aggregate_snapshots.sql", import.meta.url), "utf8");
const privacyMigration = readFileSync(new URL("../../supabase/migrations/20261128085459_fam_development_advisor_privacy_banded_snapshots.sql", import.meta.url), "utf8");
const upgradeMigration = readFileSync(new URL("../../supabase/migrations/20261128100000_fam_development_advisor_idea_backlog_band.sql", import.meta.url), "utf8");

test("advisor asks for a proposal only after six consecutive aggregate snapshots", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: `2026-11-${String(27 - i).padStart(2, "0")}T06:00:00Z`,
    active_listings_band: i < 3 ? "5_9" : "10_24",
    new_listings_24h_band: i < 3 ? "suppressed" : "5_9",
    pending_council_ideas_band: i < 3 ? "10_24" : "5_9",
  }));
  const result = buildDevelopmentAdvisor(rows, { now: Date.parse("2026-11-27T07:00:00Z") });
  assert.equal(result.state, "confirmed");
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[0].key, "review_listing_discovery");
  assert.equal(result.proposals[0].authority, "recommendation_only");
  assert.equal(result.proposals[0].scope, "FAM_CURRENT");
  assert.equal(result.proposals[0].design_brief.status, "proposal_only");
  assert.equal(result.proposals[0].design_brief.priority, "advisory");
  assert.ok(result.proposals[0].design_brief.options.some((item) => item.includes("макет")));
  assert.ok(result.proposals[0].design_brief.acceptance_checks.some((item) => item.includes("независимую QA")));
  assert.match(renderDevelopmentAdvisor(result), /UX-задание:/);
  assert.match(renderDevelopmentAdvisor(result), /Критерии:/);
  assert.match(renderDevelopmentAdvisor(result), /гипотеза/);
  assert.equal(result.proposals[1].key, "review_idea_feedback_loop");
  assert.equal(result.proposals[1].authority, "recommendation_only");
  assert.match(renderDevelopmentAdvisor(result), /не менее пяти школ/);
});

test("advisor suppresses idea signals for small samples and emits no idea proposal", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: `2026-11-${String(27 - i).padStart(2, "0")}T06:00:00Z`,
    active_listings_band: "10_24",
    new_listings_24h_band: "suppressed",
    pending_council_ideas_band: i < 3 ? "suppressed" : "5_9",
  }));
  const result = buildDevelopmentAdvisor(rows, { now: Date.parse("2026-11-27T07:00:00Z") });
  assert.equal(result.state, "checked_no_signal");
  assert.deepEqual(result.proposals, []);
});

test("advisor emits no product hypothesis for missing, stale, gapped or malformed data", () => {
  assert.equal(buildDevelopmentAdvisor([]).state, "no_data");
  const stale = Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: "2026-11-20T06:00:00Z", active_listings_band: "10_24", new_listings_24h_band: "suppressed",
    pending_council_ideas_band: "none",
  }));
  assert.equal(buildDevelopmentAdvisor(stale, { now: Date.parse("2026-11-27T07:00:00Z") }).proposals.length, 0);
  assert.equal(buildDevelopmentAdvisor([{ report_date: "bad", active_listings_band: "forbidden" }]).state, "no_data");
  const incomplete = Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: `2026-11-${String(27 - i).padStart(2, "0")}T06:00:00Z`,
    active_listings_band: i === 0 ? "unknown" : "suppressed",
    new_listings_24h_band: "suppressed",
    pending_council_ideas_band: "none",
  }));
  const result = buildDevelopmentAdvisor(incomplete, { now: Date.parse("2026-11-27T07:00:00Z") });
  assert.equal(result.state, "no_data");
  assert.equal(result.reason, "incomplete_aggregate");
  assert.equal(buildDevelopmentAdvisor(Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: `2026-11-${String(27 - i).padStart(2, "0")}T06:00:00Z`,
    active_listings_band: "10_24", new_listings_24h_band: "none", pending_council_ideas_band: "none",
  })), { now: Date.parse("2026-11-27T07:00:00Z") }).state, "no_data");
});

test("advisor SQL is limited to predefined aggregates and service-role execution", () => {
  const body = migration.slice(migration.indexOf("$function$"), migration.lastIndexOf("$function$"));
  assert.match(migration, /security invoker/i);
  assert.match(migration, /private\.fam_agent_daily_reports/);
  assert.match(migration, /active_listings integer/);
  assert.match(migration, /new_listings_24h integer/);
  assert.match(upgradeMigration, /drop function public\.get_fam_development_advisor_snapshots\(integer\)/i);
  assert.match(upgradeMigration, /active_listings_band text/);
  assert.match(upgradeMigration, /new_listings_24h_band text/);
  assert.match(upgradeMigration, /pending_council_ideas_band text/);
  assert.match(upgradeMigration, /security invoker/i);
  assert.match(upgradeMigration, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(upgradeMigration, /drop function[^;]*cascade/i);
  assert.match(upgradeMigration, /private\.fam_agent_school_daily_reports/);
  assert.match(upgradeMigration, /least\(pending_count, 5\)/);
  assert.match(upgradeMigration, /positive_schools between 1 and 4 then 'suppressed'/);
  assert.match(upgradeMigration, /pending_council_ideas_band text/);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  const privacyBody = privacyMigration.slice(privacyMigration.indexOf("$function$"), privacyMigration.lastIndexOf("$function$"));
  assert.match(privacyMigration, /drop function public\.get_fam_development_advisor_snapshots\(integer\)/i);
  assert.match(privacyMigration, /create function public\.get_fam_development_advisor_snapshots/i);
  assert.match(privacyMigration, /active_listings_band text/);
  assert.match(privacyMigration, /new_listings_24h_band text/);
  assert.doesNotMatch(privacyMigration, /then 'none'/);
  assert.match(privacyMigration, /!~ '\^\(0\|\[1-9\]\[0-9\]\{0,17\}\)\$'/);
  assert.doesNotMatch(privacyBody, /public\.(profiles|event_registrations|messages|fam_safety_incidents)|user_id|email|payload/i);
  assert.doesNotMatch(upgradeMigration, /\(r\.metrics #>> '\{listings,(active|new_24h)\}'\)::integer = 0 then 'none'/);
  assert.doesNotMatch(body, /public\.(profiles|event_registrations|messages|fam_safety_incidents)|user_id|email|payload/i);
  const upgradeBody = upgradeMigration.slice(upgradeMigration.indexOf("$function$"), upgradeMigration.lastIndexOf("$function$"));
  assert.doesNotMatch(upgradeBody, /public\.(profiles|event_registrations|messages|fam_safety_incidents)|user_id|email|payload/i);
});
