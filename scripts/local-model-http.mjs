import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * POST JSON without undici's fixed response-header timeout.
 * Local CPU inference can spend several minutes in prompt evaluation before
 * llama-server sends its first response headers. The socket timeout is explicit
 * and is longer than the Qwen worker's normal prompt-evaluation window.
 */
export function postJson(url, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number.");
  }

  const target = new URL(url);
  const requestFn = target.protocol === "https:"
    ? httpsRequest
    : target.protocol === "http:"
      ? httpRequest
      : null;

  if (!requestFn) {
    throw new TypeError("Only HTTP and HTTPS model endpoints are supported.");
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    let responseBytes = 0;
    let responseBody = "";

    const request = requestFn(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Local inference response exceeded the 8 MiB limit."));
          return;
        }
        responseBody += chunk;
      });

      response.on("aborted", () => {
        reject(new Error("Local inference response was interrupted."));
      });

      response.on("error", reject);

      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error("Local inference failed with HTTP " + status));
          return;
        }

        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(new Error("Local inference returned invalid JSON."));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(
        "Local inference timed out after " + Math.round(timeoutMs / 60000) + " minutes.",
      ));
    });
    request.on("error", reject);
    request.end(body);
  });
}
