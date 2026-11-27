// FAM photo moderation compatibility helper.
import { boundedRetryDelayMs } from "./image-reviewer-utils.js";

export type ImageReviewAction = "ok" | "reject" | "pending";
export type ImageReviewResult = {
  action: ImageReviewAction;
  reason_code: string;
  reason: string;
  model?: string | null;
};

const MODEL = "omni-moderation-latest";

export async function reviewListingImage(
  _listingText: string,
  imageUrl: string,
  apiKey: string,
  _purpose: "listing" | "avatar" | "idea" = "listing",
): Promise<ImageReviewResult> {
  if (!apiKey || !imageUrl) return { action: "pending", reason_code: "image_reviewer_unavailable", reason: "Проверка фотографии временно недоступна. Фото не опубликовано." };
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12_000);
    try {
      response = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: [{ type: "image_url", image_url: { url: imageUrl } }] }),
        signal: controller.signal,
      });
      if (response.ok || response.status !== 429 || attempt > 0) break;
      await new Promise(resolve => setTimeout(resolve, boundedRetryDelayMs(response.headers.get("retry-after"))));
    } catch (error) {
      console.warn("fam_image_review_request_failed", error instanceof Error ? error.name : "unknown");
      break;
    } finally { clearTimeout(timeoutId); }
  }
  if (!response?.ok) return {
    action: "pending",
    reason_code: response?.status === 429 ? "image_review_rate_limited" : "image_review_unavailable",
    reason: "Сервис проверки временно недоступен. Фото пока не опубликовано.",
  };
  const body = await response.json().catch(() => null);
  const result = body?.results?.[0];
  if (!result || typeof result.flagged !== "boolean") return {
    action: "pending", reason_code: "image_review_no_decision",
    reason: "Не удалось проверить фотографию. Она пока не опубликована.", model: MODEL,
  };
  if (result.flagged) return {
    action: "pending", reason_code: "image_requires_human_review",
    reason: "Фотография требует дополнительной проверки. Пока она не опубликована.", model: MODEL,
  };
  return {
    action: "ok", reason_code: "image_moderation_clear",
    reason: "Фотография прошла автоматическую проверку безопасности.", model: MODEL,
  };
}
