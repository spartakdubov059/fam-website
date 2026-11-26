const MAX_MODERATION_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const LABELLED_NAME_RE = /(?<![\p{L}\p{N}])((?:фио|ф\.\s*и\.\s*о\.|полное\s+имя)\s*[:=—-]\s*)([\p{L}'’-]+(?:\s+[\p{L}'’-]+){1,2})/giu;
const LABELLED_IDENTIFIER_RE = /(?<![\p{L}\p{N}])((?:дата\s+рождения|дата\s+рожд\.?|паспорт(?:ные\s+данные)?|номер\s+ученика|student\s+id|birth\s+date)\s*[:=—-]\s*)([^\n,;.!?]{1,40})/giu;
const CONTEXTUAL_NAME_RE = /(?<![\p{L}\p{N}])((?:[Уу]ченик(?:а|у|ом)?|[Уу]чениц(?:а|ы|е|у|ей)?|[Шш]кольник(?:а|у|ом)?|[Шш]кольниц(?:а|ы|е|у|ей)?|[Оо]дноклассник(?:а|у|ом)?|[Оо]дноклассниц(?:а|ы|е|у|ей)?|[Уу]чител(?:ь|я|ю|ем|е)|[Зз]овут|[Ии]мя|[Ss]tudent|[Cc]lassmate|[Tt]eacher|[Nn]amed)\s+)([А-ЯЁA-Z][\p{L}'’-]{1,30}(?:\s+[А-ЯЁA-Z][\p{L}'’-]{1,30}){0,2})(?=$|[\s,.;:!?])/gu;

// This is a best-effort text minimizer, not a general PII detector. It preserves
// role words and surrounding context so moderation can still assess conduct.
export function redactStructuredPersonalData(value) {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(LABELLED_NAME_RE, (_match, label) => label + "[PERSON]")
    .replace(LABELLED_IDENTIFIER_RE, (_match, label) => label + "[PERSONAL_DATA]")
    .replace(CONTEXTUAL_NAME_RE, (_match, context) => context + "[PERSON]");
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function fetchPrivateImageAsDataUrl(imageUrl, {
  storageOrigin,
  expectedPathPrefix,
  fetchImpl = fetch,
  maxBytes = MAX_MODERATION_IMAGE_BYTES,
  timeoutMs = 8_000,
} = {}) {
  let parsed;
  let expectedOrigin;
  try {
    parsed = new URL(imageUrl);
    expectedOrigin = new URL(storageOrigin).origin;
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" || parsed.origin !== expectedOrigin ||
    typeof expectedPathPrefix !== "string" || !parsed.pathname.startsWith(expectedPathPrefix) ||
    !parsed.searchParams.has("token") || !Number.isSafeInteger(maxBytes) || maxBytes < 1
  ) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(parsed.href, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return null;

    const mimeType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.cancel().catch(() => {});
      return null;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    if (total === 0) return null;

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { dataUrl: `data:${mimeType};base64,${toBase64(bytes)}`, byteLength: total, mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
