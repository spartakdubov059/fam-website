
import { isRetryableModerationFailure, retryDelaySeconds, MAX_IMAGE_MODERATION_ATTEMPTS } from "./retry-policy.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const WORKER_TOKEN = Deno.env.get("FAM_AGENT_WORKER_TOKEN") ?? "";
const SUPABASE_SECRET_KEY = readDefaultKey("SUPABASE_SECRET_KEYS")
  || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  || Deno.env.get("SUPABASE_SECRET_KEY")
  || "";
const LEGACY_SECRET_IS_JWT = SUPABASE_SECRET_KEY.startsWith("eyJ");

function readDefaultKey(variable) {
  const raw = Deno.env.get(variable) ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    // Legacy service-role keys are plain strings.
  }
  return raw;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function sameSecret(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function adminHeaders(contentType = null) {
  const headers = { apikey: SUPABASE_SECRET_KEY };
  if (LEGACY_SECRET_IS_JWT) headers.Authorization = "Bearer " + SUPABASE_SECRET_KEY;
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function rpc(name, body) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: adminHeaders("application/json"),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error("rpc_" + name + "_failed_" + response.status);
  return data;
}

function safePendingPath(task) {
  const userId = String(task.user_id || "");
  const path = String(task.image_path || "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
  return new RegExp("^" + userId + "/listing_" + userId + "_[a-z0-9-]{1,50}\\.(?:jpg|png|webp)$", "i").test(path);
}

async function createSignedImageUrl(path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    SUPABASE_URL + "/storage/v1/object/sign/listing-images-pending/" + encodedPath,
    {
      method: "POST",
      headers: adminHeaders("application/json"),
      body: JSON.stringify({ expiresIn: 600 }),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.signedURL !== "string") {
    throw new Error("pending_image_sign_failed");
  }
  if (data.signedURL.startsWith("http")) return data.signedURL;
  if (data.signedURL.startsWith("/storage/v1/")) return SUPABASE_URL + data.signedURL;
  return SUPABASE_URL + "/storage/v1" + (data.signedURL.startsWith("/") ? "" : "/") + data.signedURL;
}

async function callModeration(task, imageUrl) {
  const response = await fetch(SUPABASE_URL + "/functions/v1/moderate", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      "x-fam-internal-key": SUPABASE_SECRET_KEY,
    },
    body: JSON.stringify({
      text: [task.title, task.description, task.price_text || "Бесплатно"].join("\n"),
      image_url: imageUrl,
      image_purpose: "listing",
      context: {
        kind: "listing",
        sender_id: task.user_id,
        school_id: task.school_id || "",
      },
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !["ok", "pending", "reject"].includes(data.action)) {
    return {
      action: "pending",
      degraded: true,
      diagnostic_code: "moderation_internal_error",
      reason: "Внутренняя проверка временно недоступна.",
    };
  }
  return data;
}

async function fetchImageBytes(signedUrl) {
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error("pending_image_download_failed");
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = extensions[mime];
  if (!extension) throw new Error("pending_image_invalid_mime");
  const statedLength = Number(response.headers.get("content-length") || 0);
  if (statedLength > 5 * 1024 * 1024) throw new Error("pending_image_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error("pending_image_too_large");
  return { bytes, mime, extension };
}

async function publishApprovedImage(task, signedUrl) {
  const { bytes, mime, extension } = await fetchImageBytes(signedUrl);
  const publicPath = "listing_" + task.user_id + "_" + crypto.randomUUID() + "." + extension;
  const response = await fetch(
    SUPABASE_URL + "/storage/v1/object/listings-images/" + encodeURIComponent(publicPath),
    {
      method: "POST",
      headers: { ...adminHeaders(mime), "x-upsert": "false" },
      body: bytes,
    },
  );
  if (!response.ok) throw new Error("approved_image_publish_failed_" + response.status);
  return {
    path: publicPath,
    url: SUPABASE_URL + "/storage/v1/object/public/listings-images/" + publicPath,
  };
}

async function removeObject(bucket, path) {
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket, {
      method: "DELETE",
      headers: adminHeaders("application/json"),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) console.warn("fam_image_worker_storage_cleanup_failed", bucket, response.status);
  } catch {
    console.warn("fam_image_worker_storage_cleanup_failed", bucket, "network_error");
  }
}

async function finish(task, state, details = {}) {
  const result = await rpc("finish_listing_image_moderation_task", {
    p_queue_id: task.queue_id,
    p_state: state,
    p_reason_code: details.reason_code || null,
    p_reason: details.reason || null,
    p_retry_seconds: details.retry_seconds || null,
    p_image_url: details.image_url || null,
  });
  if (result !== true) throw new Error("moderation_queue_finish_not_applied");
}

async function scheduleRetryOrManual(task, result) {
  const reasonCode = String(result.reason_code || result.diagnostic_code || "provider_unavailable").slice(0, 80);
  const reason = String(result.reason || "Проверка временно недоступна.").slice(0, 180);
  const retryable = isRetryableModerationFailure(result);
  if (retryable && Number(task.attempts) < MAX_IMAGE_MODERATION_ATTEMPTS) {
    await finish(task, "retry", {
      reason_code: reasonCode,
      reason,
      retry_seconds: retryDelaySeconds(task.attempts),
    });
    return "retry";
  }
  await finish(task, "manual_review", {
    reason_code: reasonCode,
    reason: retryable ? "Автоматические попытки временно исчерпаны; требуется дополнительная проверка." : reason,
  });
  return "manual_review";
}

async function processTask(task) {
  if (!safePendingPath(task) || !task.queue_id) {
    await finish(task, "failed", { reason_code: "invalid_pending_image_path", reason: "Не удалось подтвердить временный файл." });
    return "failed";
  }

  let signedUrl = null;
  let publishedPath = null;
  try {
    signedUrl = await createSignedImageUrl(task.image_path);
    const moderation = await callModeration(task, signedUrl);

    if (moderation.action === "reject") {
      await finish(task, "rejected", {
        reason_code: moderation.reason_code || "content_rejected",
        reason: moderation.reason || "Фото не соответствует правилам FAM.",
      });
      await removeObject("listing-images-pending", task.image_path);
      return "rejected";
    }

    if (moderation.action === "pending") {
      return await scheduleRetryOrManual(task, moderation);
    }

    const published = await publishApprovedImage(task, signedUrl);
    publishedPath = published.path;
    await finish(task, "approved", {
      reason_code: "image_review_approved",
      reason: "Фотография прошла автоматическую проверку.",
      image_url: published.url,
    });
    await removeObject("listing-images-pending", task.image_path);
    return "approved";
  } catch (error) {
    if (publishedPath) await removeObject("listings-images", publishedPath);
    const fallback = {
      action: "pending",
      degraded: true,
      diagnostic_code: "moderation_internal_error",
      reason: "Сервис проверки или хранилище временно недоступны.",
    };
    try {
      return await scheduleRetryOrManual(task, fallback);
    } catch {
      console.error("fam_listing_image_task_reschedule_failed", String(task.queue_id));
      return "blocked";
    }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (req.headers.get("origin")) return json({ ok: false, error: "origin_not_allowed" }, 403);
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !WORKER_TOKEN) {
    return json({ ok: false, error: "worker_not_configured" }, 503);
  }
  if (!await sameSecret(req.headers.get("x-fam-agent-token") || "", WORKER_TOKEN)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let limit = 2;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.limit)) limit = Math.max(1, Math.min(4, body.limit));
  } catch {
    // Empty request uses the safe default.
  }

  try {
    const tasks = await rpc("claim_listing_image_moderation_tasks", {
      p_limit: limit,
      p_lease_seconds: 120,
    });
    if (!Array.isArray(tasks)) return json({ ok: false, error: "invalid_queue_response" }, 502);

    const counts = { claimed: tasks.length, approved: 0, rejected: 0, retry: 0, manual_review: 0, failed: 0, blocked: 0 };
    for (const task of tasks) {
      const state = await processTask(task);
      if (Object.hasOwn(counts, state)) counts[state]++;
      else counts.blocked++;
    }
    return json({ ok: true, ...counts });
  } catch (error) {
    console.error("fam_listing_image_worker_failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false, error: "worker_execution_failed" }, 500);
  }
});
