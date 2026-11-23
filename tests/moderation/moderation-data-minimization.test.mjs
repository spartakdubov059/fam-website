import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchPrivateImageAsDataUrl,
  redactStructuredPersonalData,
} from "../../supabase/functions/moderate/data-minimization.js";

const source = readFileSync(new URL("../../supabase/functions/moderate/index.ts", import.meta.url), "utf8");
const origin = "https://tfacqpljrvfpcrhdovbu.supabase.co";
const prefix = "/storage/v1/object/sign/listing-images-pending/11111111-1111-4111-8111-111111111111/listing_11111111-1111-4111-8111-111111111111_";
const signedUrl = `${origin}${prefix}abc.webp?token=synthetic-token`;

test("external text masks structured identifiers while retaining moderation meaning", () => {
  const text = "ФИО: Иван Иванович Иванов; ученик Алексей Петров угрожал и травил одноклассника.";
  const redacted = redactStructuredPersonalData(text);
  assert.doesNotMatch(redacted, /Иван Иванович Иванов|Алексей Петров/);
  assert.match(redacted, /угрожал и травил/);
  assert.match(redacted, /ученик \[PERSON\]/);
  assert.match(redacted, /ФИО: \[PERSON\]/);
});

test("unlabelled personal information is documented as an explicit detector limitation", () => {
  const text = "Маша угрожает Вике после уроков.";
  assert.equal(redactStructuredPersonalData(text), text);
});

test("contact policy continues to reject before the OpenAI payload is built", () => {
  const contactGate = source.slice(source.indexOf("if (containsContactData(value))"), source.indexOf("// Local rules run first"));
  assert.match(contactGate, /return jsonResponse\([\s\S]*?reason_code: "personal_contact_data"/);
  assert.ok(source.indexOf("if (containsContactData(value))") < source.indexOf("const externalText = redactStructuredPersonalData(value)"));
});

test("image fetch requires the expected private Storage origin/path and token", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(new Uint8Array([1])); };
  const result = await fetchPrivateImageAsDataUrl(signedUrl, { storageOrigin: origin, expectedPathPrefix: prefix, fetchImpl });
  assert.equal(result, null, "missing content-type is rejected fail-closed");
  await fetchPrivateImageAsDataUrl("https://attacker.example/image.png?token=x", { storageOrigin: origin, expectedPathPrefix: prefix, fetchImpl });
  await fetchPrivateImageAsDataUrl(`${origin}${prefix}abc.webp`, { storageOrigin: origin, expectedPathPrefix: prefix, fetchImpl });
  assert.equal(requests, 1, "invalid host and missing token never cause a request");
});

test("supported images become bounded data URLs, not OpenAI-fetchable Supabase URLs", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let options;
  const result = await fetchPrivateImageAsDataUrl(signedUrl, {
    storageOrigin: origin,
    expectedPathPrefix: prefix,
    fetchImpl: async (_url, requestOptions) => {
      options = requestOptions;
      return new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
    },
  });
  assert.deepEqual(result, { dataUrl: "data:image/png;base64,iVBORw==", byteLength: 4, mimeType: "image/png" });
  assert.equal(options.redirect, "error");
  assert.match(source, /image_url: \{ url: externalImageUrl \}/);
  assert.match(source, /fam-openai-moderation-v4/);
  assert.doesNotMatch(source, /image_url: \{ url: imageUrl \}/);
});

test("oversized and unsupported images fail closed to manual review", async () => {
  const oversized = await fetchPrivateImageAsDataUrl(signedUrl, {
    storageOrigin: origin,
    expectedPathPrefix: prefix,
    maxBytes: 2,
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  });
  const unsupported = await fetchPrivateImageAsDataUrl(signedUrl, {
    storageOrigin: origin,
    expectedPathPrefix: prefix,
    fetchImpl: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/svg+xml" } }),
  });
  assert.equal(oversized, null);
  assert.equal(unsupported, null);
  assert.match(source, /Фото не удалось безопасно подготовить[\s\S]*?image_requires_human_review/);
});
