import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/fam-agent-coder-qa-postgres.yml", import.meta.url),
  "utf8",
);

test("coder QA uses the reviewed bounded-retry migration revision", () => {
  assert.match(workflow, /RETRY_MIGRATION_SOURCE_SHA: 56b32463adfab345cfc1eb1d9360f6b5b2b661ec/);
  assert.match(workflow, /FETCHED_RETRY_SOURCE_SHA.*RETRY_MIGRATION_SOURCE_SHA/);
  assert.match(workflow, /git show "\$RETRY_MIGRATION_SOURCE_SHA:supabase\/migrations\/20261113100000_fam_agent_bounded_coder_retries\.sql"/);
  assert.match(workflow, /update the pinned integration fixture/);
});
