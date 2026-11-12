// FAM User Safety Agent.
// It receives only structured moderation signals and never stores raw message text or user IDs.

export type SafetyContext = {
  kind: "message" | "idea" | "listing" | "image";
  sender_id: string;
  receiver_id?: string | null;
  school_id: string;
  source_origin?: string | null;
  evidence_excerpt?: string | null;
};

export type SafetyCategory =
  | "targeted_harassment"
  | "hate_or_discrimination"
  | "threat_or_intimidation"
  | "negative_personal_call"
  | "spam_or_repeated_abuse"
  | "unsafe_image"
  | "personal_data_in_image"
  | "unclear_safety_signal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function isLegacyJwt(value: string): boolean {
  return value.startsWith("eyJ");
}

function safeOriginHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().slice(0, 120);
  } catch {
    return null;
  }
}

function safeEvidenceExcerpt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[почта скрыта]")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "[ссылка скрыта]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[номер скрыт]")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
  return cleaned || null;
}

export async function recordSafetySignal(args: {
  context: SafetyContext | null;
  category: SafetyCategory;
  severity: "medium" | "high";
  supabaseUrl: string;
  serviceKey: string;
}): Promise<boolean> {
  const { context, category, severity, supabaseUrl, serviceKey } = args;
  if (!context || !supabaseUrl || !serviceKey) return false;
  if (!UUID_RE.test(context.sender_id) || typeof context.school_id !== "string" || !context.school_id) return false;
  if (!["message", "idea", "listing", "image"].includes(context.kind)) return false;

  const isMessage = context.kind === "message";
  if (isMessage && (!context.receiver_id || !UUID_RE.test(context.receiver_id))) return false;

  // A keyed HMAC groups repeated incidents without exposing a guessable participant fingerprint.
  // The key remains server-side. Exact account IDs are stored only in this RLS-locked table;
  // short text excerpts are redacted before storage and exposed only to the same-school admin.
  const fingerprintSource = isMessage
    ? [context.school_id, "message", context.sender_id, context.receiver_id].join("|")
    : [context.school_id, context.kind, context.sender_id].join("|");

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(serviceKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode("fam-safety-fingerprint-v1|" + fingerprintSource),
  );
  const pairFingerprint = toHex(new Uint8Array(digest));

  const headers: Record<string, string> = {
    "apikey": serviceKey,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
  };
  if (isLegacyJwt(serviceKey)) headers["Authorization"] = "Bearer " + serviceKey;

  try {
    const response = await fetch(supabaseUrl + "/rest/v1/fam_safety_incidents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        school_id: context.school_id,
        pair_fingerprint: pairFingerprint,
        source_kind: context.kind,
        category,
        severity,
        actor_id: context.sender_id,
        target_id: isMessage ? context.receiver_id ?? null : null,
        source_origin: safeOriginHost(context.source_origin),
        evidence_excerpt: context.kind === "image"
          ? null
          : safeEvidenceExcerpt(context.evidence_excerpt),
      }),
    });
    if (!response.ok) {
      console.warn("fam_safety_signal_store_failed", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("fam_safety_signal_store_error", error instanceof Error ? error.name : "unknown");
    return false;
  }
}
