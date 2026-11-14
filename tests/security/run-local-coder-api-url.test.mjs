import test from "node:test";
import assert from "node:assert/strict";
import { resolveLocalModelApiUrl } from "../../scripts/local-model-url.mjs";

test("local coder accepts a configurable loopback chat-completions endpoint", () => {
  assert.equal(
    resolveLocalModelApiUrl("http://127.0.0.1:43127/v1/chat/completions"),
    "http://127.0.0.1:43127/v1/chat/completions",
  );
});

test("local coder rejects model endpoints outside the loopback chat-completions path", () => {
  for (const value of [
    "https://127.0.0.1:43127/v1/chat/completions",
    "http://localhost:43127/v1/chat/completions",
    "http://127.0.0.2:43127/v1/chat/completions",
    "http://192.0.2.10:43127/v1/chat/completions",
    "http://127.0.0.1/v1/chat/completions",
    "http://127.0.0.1:43127/other",
    "http://user:pass@127.0.0.1:43127/v1/chat/completions",
    "http://127.0.0.1:43127/v1/chat/completions?token=secret",
  ]) {
    assert.throws(() => resolveLocalModelApiUrl(value), /loopback chat-completions endpoint/);
  }
});
