import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the synthetic pipeline repair is present in the clean QA checkout", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /<title>FAM fixture fixed<\/title>/);
});
