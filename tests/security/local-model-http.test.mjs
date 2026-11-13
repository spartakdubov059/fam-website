import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { postJson, LocalInferenceTimeoutError } from "../../scripts/local-model-http.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("local model HTTP client tolerates delayed response headers", async () => {
  await withServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ received: JSON.parse(body) }));
      }, 120);
    });
  }, async (url) => {
    const result = await postJson(url, { prompt: "local test" }, { timeoutMs: 2_000 });
    assert.deepEqual(result, { received: { prompt: "local test" } });
  });
});

test("local model HTTP client enforces its explicit socket timeout", async () => {
  await withServer((_request, response) => {
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }, 150);
  }, async (url) => {
    await assert.rejects(
      postJson(url, { prompt: "timeout test" }, { timeoutMs: 25 }),
      LocalInferenceTimeoutError,
    );
  });
});

test("local model HTTP client rejects non-JSON and non-success responses", async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end("unavailable");
  }, async (url) => {
    await assert.rejects(
      postJson(url, {}),
      /Local inference failed with HTTP 503/,
    );
  });
});
