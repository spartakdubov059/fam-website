import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const reviewer = readFileSync(new URL("supabase/functions/moderate/dispute-reviewer.ts", root), "utf8");
const moderator = readFileSync(new URL("supabase/functions/moderate/index.ts", root), "utf8");
const contentSafety = readFileSync(new URL("supabase/functions/moderate/content-safety.js", root), "utf8");

test("the idea prompt explicitly permits constructive criticism and frustrated tone", () => {
  assert.match(reviewer, /КОНСТРУКТИВНАЯ КРИТИКА разрешена/);
  assert.match(reviewer, /Обычная грубость, резкая формулировка, непопулярное мнение или критика не являются основанием для manual_review/);
  assert.match(reviewer, /не направляй такую идею на дополнительную проверку только из-за отрицательного тона/);
});

test("ordinary personal insults, spam and unclear accusations are automatically rejected, not manually queued", () => {
  assert.match(reviewer, /ОТКЛОНЯЙ автоматически/);
  assert.match(reviewer, /action: "reject",\s*reason_code: "unclear_or_personal_accusation"/);
  assert.match(reviewer, /"targeted_harassment"/);
  assert.match(reviewer, /"negative_personal_call"/);
});

test("only serious hate, discrimination, threats and severe targeted harassment map to human review", () => {
  assert.match(reviewer, /const highRiskCodes = new Set\(\[\s*"hate_or_discrimination",\s*"threat_or_intimidation",\s*"severe_targeted_harassment"/);
  assert.match(reviewer, /decision === "manual_review" && highRiskCodes\.has/);
  assert.match(reviewer, /"hate_or_discrimination"/);
  assert.match(reviewer, /"threat_or_intimidation"/);
  assert.match(reviewer, /"severe_targeted_harassment"/);
});

test("provider outage approves locally clean ideas but holds text matching local safety flags", () => {
  assert.match(reviewer, /if \(!apiKey\) return safeLocalFallback\(\)/);
  assert.match(reviewer, /action: "ok",\s*reason_code: "safe_local_fallback"/);
  assert.match(reviewer, /action: "pending",\s*reason_code: "local_policy_flag_requires_review"/);
  assert.match(contentSafety, /serious_hate_or_threat/);
  assert.match(moderator, /reviewIdeaContent\(value, OPENAI_KEY, policyFlag\?\.code \?\? null\)/);
  assert.doesNotMatch(moderator, /if \(!OPENAI_KEY\) \{\s*return jsonResponse\(\{\s*action: "pending"/);
});

test("serious idea findings are recorded as higher-severity safety signals", () => {
  assert.match(moderator, /hate_or_discrimination"\) \{\s*await writeSafetySignal\(safetyContext, "hate_or_discrimination", "high"\)/);
  assert.match(moderator, /threat_or_intimidation"\) \{\s*await writeSafetySignal\(safetyContext, "threat_or_intimidation", "high"\)/);
  assert.match(moderator, /severe_targeted_harassment/);
});
