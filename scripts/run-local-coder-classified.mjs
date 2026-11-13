import { LocalInferenceTimeoutError } from "./local-model-http.mjs";

try {
  await import("./run-local-coder.mjs");
} catch (error) {
  console.error(error);
  process.exitCode = error instanceof LocalInferenceTimeoutError ? 75 : 1;
}
