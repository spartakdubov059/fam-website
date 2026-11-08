// FAM User Safety Agent.
// It receives only structured moderation signals and never stores raw message text or user IDs.

export type SafetyContext = {
  kind: "message" | "idea" | "listing" | "image";
  sender_id: string;
  receiver_id?: string | null;
  school_id: string;
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

  // Fingerprint preserves the directed sender/recipient pattern but is not reversible
  // from the dashboard. Raw identifiers and message content are never written.
  const fingerprintSource = isMessage
    ? [context.school_id, "message", context.sender_id, context.receiver_id].join("|")
    : [context.school_id, context.kind, context.sender_id].join("|");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprintSource),
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
        source_kind: context.kind === "listing" || context.kind === "image" ? "image" : context.kind,
        category,
        severity,
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
