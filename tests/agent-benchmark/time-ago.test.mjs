import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const start = html.indexOf("  function timeAgo(");
const end = html.indexOf("\n\n  // Append a stable, unique entry", start);
assert.ok(start >= 0 && end > start, "timeAgo source must be present in index.html");

const functionSource = html.slice(start, end).trim();
const fixedNow = Date.parse("2026-11-12T12:00:00.000Z");
class FixedDate extends Date {
  static now() {
    return fixedNow;
  }
}
const timeAgo = vm.runInNewContext("(" + functionSource + ")", { Date: FixedDate });

test("timeAgo returns an empty label for invalid or non-finite timestamps", () => {
  assert.equal(timeAgo("not-a-date"), "");
  assert.equal(timeAgo(Number.NaN), "");
  assert.equal(timeAgo(Number.POSITIVE_INFINITY), "");
  assert.equal(timeAgo(null), "");
  assert.equal(timeAgo(undefined), "");
  assert.equal(timeAgo(""), "");
});

test("timeAgo treats the Unix epoch value zero as a valid timestamp", () => {
  const label = timeAgo(0);
  assert.notEqual(label, "");
  assert.notEqual(label, "Invalid Date");
  assert.match(label, /1970/);
});

test("timeAgo preserves the existing relative label for valid recent dates", () => {
  assert.equal(timeAgo("2026-11-12T11:30:00.000Z"), "30 мин. назад");
});
