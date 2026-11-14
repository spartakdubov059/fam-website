import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTechnicalSignals } from "../../scripts/fam-agent-analyst.mjs";

test("groups allowlisted signals by technical pattern and page area", () => {
  const result = analyzeTechnicalSignals([
    { event_code: "js_runtime", page_area: "listings", occurrences: 4 },
    { event_code: "unhandled_rejection", page_area: "listings", occurrences: 3 },
    { event_code: "auth_backend_failed", page_area: "auth", occurrences: 2 },
  ]);
  assert.equal(result.status, "hypotheses_available");
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].key, "runtime");
  assert.equal(result.findings[0].occurrences, 7);
  assert.deepEqual(result.findings[0].event_codes, ["js_runtime", "unhandled_rejection"]);
  assert.match(result.findings[0].hypothesis, /точная причина не содержится/);
  assert.match(result.limitations, /первопричина не подтверждается/);
});

test("ignores unknown enums, malformed values, extra fields, and empty input without leaking text", () => {
  const result = analyzeTechnicalSignals([
    { event_code: "attacker text", page_area: "other", occurrences: 999, description: "private data" },
    { event_code: "constructor", page_area: "other", occurrences: 999 },
    { event_code: "toString", page_area: "other", occurrences: 999 },
    { event_code: "js_runtime", page_area: "unknown", occurrences: 4 },
    { event_code: "js_runtime", page_area: "auth", occurrences: -1 },
    { event_code: "js_runtime", page_area: "auth", occurrences: 1000001 },
    { event_code: "unhandled_rejection", page_area: "auth", occurrences: 0, payload: "secret" },
  ]);
  assert.equal(result.status, "no_allowlisted_signals");
  assert.deepEqual(result.findings, []);
  assert.equal(JSON.stringify(result).includes("private data"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("returns a bounded empty state for unavailable signals", () => {
  const result = analyzeTechnicalSignals(null);
  assert.deepEqual(result.findings, []);
  assert.equal(result.status, "no_allowlisted_signals");
});
