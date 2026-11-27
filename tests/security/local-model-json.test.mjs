import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRequiredFields,
  extractJsonObject,
  parseJson,
} from "../../scripts/local-model-json.mjs";

test("parses a plain JSON response", () => {
  assert.deepEqual(parseJson('{"finding_status":"issue_found","files":[]}'), {
    finding_status: "issue_found",
    files: [],
  });
});

test("parses JSON surrounded by Qwen reasoning and markdown fences", () => {
  const response = [
    "<think>Проверяю структуру ответа. В тексте могут быть фигурные скобки {пример}.</think>",
    "```json",
    '{"finding_status":"issue_found","unified_diff":"diff --git a/a b/a\\n"}',
    "```",
  ].join("\n");

  assert.deepEqual(extractJsonObject(response), {
    finding_status: "issue_found",
    unified_diff: "diff --git a/a b/a\n",
  });
});

test("does not treat braces inside JSON strings as object boundaries", () => {
  assert.deepEqual(
    parseJson('Пояснение: {"message":"значение {внутри} строки","ok":true}'),
    { message: "значение {внутри} строки", ok: true },
  );
});

test("rejects responses without a JSON object", () => {
  assert.throws(() => parseJson("<think>длинное рассуждение без ответа</think>"), /valid JSON object/);
});

test("checks required fields before accepting a model response", () => {
  const schema = { required: ["finding_status", "unified_diff"] };
  assert.throws(
    () => assertRequiredFields({ finding_status: "issue_found" }, schema, "patch response"),
    /unified_diff/,
  );
});
