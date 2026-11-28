import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDevelopmentAdvisor, renderDevelopmentAdvisor } from "../../scripts/fam-development-advisor.mjs";

const migration = readFileSync(new URL("../../supabase/migrations/20261127050000_fam_development_advisor_aggregate_snapshots.sql", import.meta.url), "utf8");

test("advisor asks for a proposal only after six consecutive aggregate snapshots", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: `2026-11-${String(27 - i).padStart(2, "0")}T06:00:00Z`,
    active_listings_band: i < 3 ? "5_9" : "10_24",
    new_listings_24h_band: i < 3 ? "none" : "5_9",
  }));
  const result = buildDevelopmentAdvisor(rows, { now: Date.parse("2026-11-27T07:00:00Z") });
  assert.equal(result.state, "confirmed");
  assert.equal(result.proposals.length, 1);
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
});

test("advisor emits no product hypothesis for missing, stale, gapped or malformed data", () => {
  assert.equal(buildDevelopmentAdvisor([]).state, "no_data");
  const stale = Array.from({ length: 6 }, (_, i) => ({
    report_date: `2026-11-${String(27 - i).padStart(2, "0")}`,
    generated_at: "2026-11-20T06:00:00Z", active_listings_band: "10_24", new_listings_24h_band: "suppressed",
  }));
  assert.equal(buildDevelopmentAdvisor(stale, { now: Date.parse("2026-11-27T07:00:00Z") }).proposals.length, 0);
  assert.equal(buildDevelopmentAdvisor([{ report_date: "bad", active_listings: -1 }]).state, "no_data");
});

test("advisor SQL is limited to predefined aggregates and service-role execution", () => {
  const body = migration.slice(migration.indexOf("$function$"), migration.lastIndexOf("$function$"));
  assert.match(migration, /security invoker/i);
  assert.match(migration, /private\.fam_agent_daily_reports/);
  assert.match(migration, /active_listings_band text/);
  assert.match(migration, /new_listings_24h_band text/);
  assert.match(migration, /then 'suppressed'/);
  assert.match(migration, /else '25_plus'/);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(body, /public\.(profiles|event_registrations|messages|fam_safety_incidents)|user_id|email|payload/i);
});
