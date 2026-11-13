import { canSkipListingImageReview } from "./photo-review-policy.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function readDefaultKey(variable: string): string {
  const raw = Deno.env.get(variable) ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    // Legacy environment variables contain a plain string, not JSON.
  }
  return raw;
}

const SUPABASE_PUBLISHABLE_KEY =
  readDefaultKey("SUPABASE_PUBLISHABLE_KEYS") ||
  Deno.env.get("SUPABASE_ANON_KEY") ||
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
  "";

const SUPABASE_SECRET_KEY =
  readDefaultKey("SUPABASE_SECRET_KEYS") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SECRET_KEY") ||
  "";

const LEGACY_SECRET_IS_JWT = SUPABASE_SECRET_KEY.startsWith("eyJ");

const ALLOWED_ORIGINS = new Set([
  "https://spartakdubov059.github.io",
  "https://mellifluous-profiterole-48c13b.netlify.app",
  "https://famru.netlify.app",
]);

const CATEGORIES = new Set(["Вещи", "Услуги", "Творчество", "Учёба", "Мероприятия"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function respond(body: Record<string, unknown>, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(message: string, status: number, headers: Record<string, string>): Response {
  return respond({ ok: false, error: message }, status, headers);
}

async function adminRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = {
    "apikey": SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
  };

  // Legacy service_role keys are JWTs and are sent in Authorization as well.
  // New sb_secret keys must be sent on apikey only.
  if (LEGACY_SECRET_IS_JWT) headers["Authorization"] = "Bearer " + SUPABASE_SECRET_KEY;
  if (method === "POST" || method === "PATCH" || method === "DELETE") {
    headers["Prefer"] = "return=representation";
  }

  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const raw = await response.text();
  let data: any = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  return { ok: response.ok, status: response.status, data };
}
function pendingListingImagePath(imageUrl: string, userId: string): string | null {
  try {
    const url = new URL(imageUrl);
    const prefix = "/storage/v1/object/sign/listing-images-pending/" + userId + "/";
    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith(prefix) || !url.searchParams.has("token")) return null;
    const tail = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!tail || tail.includes("..") || tail.includes("/") || !tail.startsWith("listing_" + userId + "_")) return null;
    if (!/\.(?:jpe?g|png|webp)$/i.test(tail)) return null;
    return userId + "/" + tail;
  } catch {
    return null;
  }
}

function storageHeaders(contentType: string | null = null): Record<string, string> {
  const headers: Record<string, string> = { "apikey": SUPABASE_SECRET_KEY };
  if (LEGACY_SECRET_IS_JWT) headers["Authorization"] = "Bearer " + SUPABASE_SECRET_KEY;
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}
function pendingAvatarImagePath(imageUrl: string, userId: string): string | null {
  try {
    const url = new URL(imageUrl);
    const prefix = "/storage/v1/object/sign/avatars-pending/" + userId + "/";
    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith(prefix) || !url.searchParams.has("token")) return null;
    const tail = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!tail || tail.includes("..") || tail.includes("/") || !tail.startsWith("avatar_" + userId + "_")) return null;
    if (!/\.(?:jpe?g|png|webp)$/i.test(tail)) return null;
    return userId + "/" + tail;
  } catch {
    return null;
  }
}

async function removePendingAvatarImage(imageUrl: string, userId: string): Promise<void> {
  const path = pendingAvatarImagePath(imageUrl, userId);
  if (!path) return;
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/avatars-pending", {
      method: "DELETE",
      headers: storageHeaders("application/json"),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) console.warn("pending_avatar_cleanup_failed", response.status);
  } catch {
    console.warn("pending_avatar_cleanup_failed", "network_error");
  }
}

async function publishPendingAvatarImage(
  imageUrl: string,
  userId: string,
  cleanupPending = true,
): Promise<{ url: string; path: string }> {
  const pendingPath = pendingAvatarImagePath(imageUrl, userId);
  if (!pendingPath) throw new Error("Не удалось подтвердить временный файл аватара.");

  const source = await fetch(imageUrl);
  if (!source.ok) throw new Error("Не удалось получить аватар для публикации.");
  const mime = (source.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const extension = extensions[mime];
  if (!extension) throw new Error("Допускаются только JPG, PNG или WebP.");
  const statedLength = Number(source.headers.get("content-length") || 0);
  if (statedLength > 2 * 1024 * 1024) throw new Error("Аватар больше допустимого размера.");
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Аватар больше допустимого размера.");

  const publicPath = userId + "/avatar_" + crypto.randomUUID() + "." + extension;
  const uploaded = await fetch(SUPABASE_URL + "/storage/v1/object/avatars/" + publicPath, {
    method: "POST",
    headers: {
      ...storageHeaders(mime),
      "x-upsert": "false",
    },
    body: bytes,
  });
  if (!uploaded.ok) {
    console.warn("approved_avatar_publish_failed", uploaded.status);
    throw new Error("Не удалось сохранить проверенный аватар.");
  }

  if (cleanupPending) await removePendingAvatarImage(imageUrl, userId);
  return {
    url: SUPABASE_URL + "/storage/v1/object/public/avatars/" + publicPath,
    path: publicPath,
  };
}

async function removePublishedAvatarImage(path: string): Promise<void> {
  if (!/^[0-9a-f-]{36}\/avatar_[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(path)) return;
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/avatars", {
      method: "DELETE",
      headers: storageHeaders("application/json"),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) console.warn("unused_avatar_cleanup_failed", response.status);
  } catch {
    console.warn("unused_avatar_cleanup_failed", "network_error");
  }
}

async function removePreviousOwnAvatarImage(imageUrl: unknown, userId: string): Promise<void> {
  if (typeof imageUrl !== "string" || !imageUrl) return;
  try {
    const url = new URL(imageUrl);
    const prefix = "/storage/v1/object/public/avatars/" + userId + "/";
    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith(prefix)) return;
    const path = decodeURIComponent(url.pathname.slice("/storage/v1/object/public/avatars/".length));
    if (path.includes("..")) return;
    await removePublishedAvatarImage(path);
  } catch {
    // Legacy or external avatar URLs are left untouched.
  }
}


async function removePendingListingImage(imageUrl: string, userId: string): Promise<void> {
  const path = pendingListingImagePath(imageUrl, userId);
  if (!path) return;
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/listing-images-pending", {
      method: "DELETE",
      headers: storageHeaders("application/json"),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) console.warn("pending_listing_image_cleanup_failed", response.status);
  } catch {
    console.warn("pending_listing_image_cleanup_failed", "network_error");
  }
}

async function publishPendingListingImage(
  imageUrl: string,
  userId: string,
): Promise<{ url: string; path: string }> {
  const pendingPath = pendingListingImagePath(imageUrl, userId);
  if (!pendingPath) throw new Error("Не удалось подтвердить временный файл фотографии.");

  const source = await fetch(imageUrl);
  if (!source.ok) throw new Error("Не удалось получить фотографию для публикации.");
  const mime = (source.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const extension = extensions[mime];
  if (!extension) throw new Error("Допускаются только JPG, PNG или WebP.");
  const statedLength = Number(source.headers.get("content-length") || 0);
  if (statedLength > 5 * 1024 * 1024) throw new Error("Фото больше допустимого размера.");
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error("Фото больше допустимого размера.");

  const publicPath = "listing_" + userId + "_" + crypto.randomUUID() + "." + extension;
  const uploaded = await fetch(SUPABASE_URL + "/storage/v1/object/listings-images/" + publicPath, {
    method: "POST",
    headers: {
      ...storageHeaders(mime),
      "x-upsert": "false",
    },
    body: bytes,
  });
  if (!uploaded.ok) {
    console.warn("approved_listing_image_publish_failed", uploaded.status);
    throw new Error("Не удалось сохранить проверенную фотографию.");
  }

  await removePendingListingImage(imageUrl, userId);
  return {
    url: SUPABASE_URL + "/storage/v1/object/public/listings-images/" + publicPath,
    path: publicPath,
  };
}

function hasImageSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (mime === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function publishPendingIdeaImage(
  imageUrl: string,
  userId: string,
): Promise<string> {
  const pendingPath = pendingListingImagePath(imageUrl, userId);
  if (!pendingPath) throw new Error("Не удалось подтвердить временный файл фотографии.");
  const source = await fetch(imageUrl);
  if (!source.ok) throw new Error("Не удалось получить фотографию для проверки.");
  const mime = (source.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = extensions[mime];
  if (!extension) throw new Error("Допускаются только JPG, PNG или WebP.");
  const statedLength = Number(source.headers.get("content-length") || 0);
  if (statedLength > 2 * 1024 * 1024) throw new Error("Фото больше допустимого размера 2 МБ.");
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Фото больше допустимого размера 2 МБ.");
  if (!hasImageSignature(bytes, mime)) throw new Error("Файл не соответствует формату фотографии. Выберите JPG, PNG или WebP.");
  const path = userId + "/idea_" + crypto.randomUUID() + "." + extension;
  const uploaded = await fetch(SUPABASE_URL + "/storage/v1/object/idea-images/" + path, {
    method: "POST", headers: { ...storageHeaders(mime), "x-upsert": "false" }, body: bytes,
  });
  if (!uploaded.ok) throw new Error("Не удалось сохранить проверенное фото предложения.");
  await removePendingListingImage(imageUrl, userId);
  return path;
}

async function removePublishedIdeaImage(path: string): Promise<void> {
  if (!/^[0-9a-f-]{36}\/idea_[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(path)) return;
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/idea-images", {
      method: "DELETE", headers: storageHeaders("application/json"), body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) console.warn("unused_idea_image_cleanup_failed", response.status);
  } catch { console.warn("unused_idea_image_cleanup_failed", "network_error"); }
}

async function removePublishedListingImage(path: string): Promise<void> {
  if (!/^listing_[0-9a-f-]{36}_[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(path)) return;
  try {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/listings-images", {
      method: "DELETE",
      headers: storageHeaders("application/json"),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!response.ok) console.warn("unused_listing_image_cleanup_failed", response.status);
  } catch {
    console.warn("unused_listing_image_cleanup_failed", "network_error");
  }
}


async function moderate(
  text: string,
  authorization: string,
  origin: string | null,
  rulesOnly = false,
  imageUrl: string | null = null,
  context: { kind: "listing" | "idea" | "message" | "image"; sender_id: string; receiver_id?: string | null; school_id: string } | null = null,
  imagePurpose: "listing" | "avatar" = "listing",
): Promise<{ action: "ok" | "pending" | "reject"; reason?: string; degraded?: boolean; diagnostic_code?: string; reason_code?: string }> {
  let response: Response;
  try {
    response = await fetch(SUPABASE_URL + "/functions/v1/moderate", {
      method: "POST",
      headers: {
        "Authorization": authorization,
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "x-fam-internal-key": SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        ...(origin && ALLOWED_ORIGINS.has(origin) ? { "Origin": origin } : {}),
      },
      body: JSON.stringify({
        text,
        rules_only: rulesOnly,
        ...(imageUrl ? { image_url: imageUrl, image_purpose: imagePurpose } : {}),
        ...(context ? { context } : {}),
      }),
    });
  } catch {
    return {
      action: "pending",
      degraded: true,
      reason: "ИИ-проверка временно недоступна. Идея будет передана Совету на ручную проверку.",
    };
  }

  if (!response.ok) {
    console.warn("Moderation Edge Function returned:", response.status);
    return {
      action: "pending",
      degraded: true,
      reason: "ИИ-проверка временно недоступна. Идея будет передана Совету на ручную проверку.",
    };
  }

  const data = await response.json().catch(() => null);
  if (!data || !["ok", "pending", "reject"].includes(data.action)) {
    return {
      action: "pending",
      degraded: true,
      reason: "ИИ вернул некорректный ответ. Идея будет передана Совету на ручную проверку.",
    };
  }

  return {
    action: data.action,
    reason: typeof data.reason === "string" ? data.reason.slice(0, 180) : undefined,
    degraded: data.degraded === true,
    diagnostic_code: typeof data.diagnostic_code === "string" ? data.diagnostic_code : undefined,
    reason_code: typeof data.reason_code === "string" ? data.reason_code : undefined,
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (origin && !ALLOWED_ORIGINS.has(origin)) return fail("Источник запроса не разрешён.", 403, headers);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return fail("Метод запроса не поддерживается.", 405, headers);

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
    return fail("Сервер отправки контента не настроен. Проверьте ключи Edge Functions.", 503, headers);
  }

  const authorization = req.headers.get("authorization") ?? "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) return fail("Необходим вход в аккаунт.", 401, headers);

  // Verify the caller's actual user session. The publishable key alone grants no user identity.
  const authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: {
      "apikey": SUPABASE_PUBLISHABLE_KEY,
      "Authorization": authorization,
    },
  });
  if (!authResponse.ok) return fail("Сессия недействительна. Войдите заново.", 401, headers);
  const authUser = await authResponse.json().catch(() => null);
  const userId = typeof authUser?.id === "string" ? authUser.id : "";
  if (!UUID_RE.test(userId)) return fail("Не удалось подтвердить пользователя.", 401, headers);

  try {
    const rawPayload = await req.text();
    if (new TextEncoder().encode(rawPayload).byteLength > 16_384) {
      return fail("Запрос слишком большой.", 413, headers);
    }
    let payload: any;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return fail("Некорректный формат запроса.", 400, headers);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("Некорректный запрос.", 400, headers);
    }

    const profileResult = await adminRequest(
      "profiles?select=id,school_id,role,avatar_url&id=eq." + encodeURIComponent(userId) + "&limit=1",
    );
    const profile = Array.isArray(profileResult.data) ? profileResult.data[0] : null;
    if (!profileResult.ok || !profile) return fail("Профиль пользователя не найден.", 403, headers);

    const suspensionResult = await adminRequest(
      "account_suspensions?select=reason,expires_at&target_id=eq." + encodeURIComponent(userId)
      + "&status=eq.active&expires_at=gt." + encodeURIComponent(new Date().toISOString())
      + "&order=created_at.desc&limit=1",
    );
    if (!suspensionResult.ok || !Array.isArray(suspensionResult.data)) {
      return fail("Не удалось проверить статус ограничений аккаунта. Попробуйте позже.", 503, headers);
    }
    const activeSuspension = suspensionResult.data[0];
    if (activeSuspension) {
      return fail(
        "Действия аккаунта временно ограничены до "
          + new Date(activeSuspension.expires_at).toLocaleString("ru-RU")
          + ". Причина: " + String(activeSuspension.reason || "").slice(0, 240),
        403,
        headers,
      );
    }

    const kind = payload.kind;
    if (!["listing", "idea", "message", "avatar"].includes(kind)) return fail("Неизвестный тип отправки.", 400, headers);

    if (kind === "avatar") {
      const imageUrl = typeof payload.image_url === "string" ? payload.image_url : "";
      const imagePath = pendingAvatarImagePath(imageUrl, userId);
      if (!imagePath) {
        return fail("Аватар должен быть загружен в защищённое временное хранилище FAM.", 400, headers);
      }

      // Use only the freshly loaded database profile, never a role sent by the browser.
      // Trusted school roles publish avatars immediately, without queueing AI image review.
      if (canSkipListingImageReview(profile, imageUrl)) {
        let published: { url: string; path: string };
        try {
          // Keep the staged object until the profile update succeeds, so a transient
          // database error does not destroy the user's only copy of the new avatar.
          published = await publishPendingAvatarImage(imageUrl, userId, false);
        } catch (error) {
          console.warn("trusted_avatar_publish_failed", error instanceof Error ? error.name : "unknown");
          return fail(
            error instanceof Error ? error.message : "Не удалось опубликовать аватар.",
            503,
            headers,
          );
        }

        // Re-check the current role and school in the UPDATE predicate to fail closed
        // if the trusted role was revoked while the file was being copied.
        const updatedProfile = await adminRequest(
          "profiles?id=eq." + encodeURIComponent(userId)
            + "&school_id=eq." + encodeURIComponent(profile.school_id)
            + "&role=in.(school_admin,council_member)",
          "PATCH",
          {
            avatar_url: published.url,
            pending_avatar_request_id: null,
          },
        );
        if (!updatedProfile.ok || !Array.isArray(updatedProfile.data) || updatedProfile.data.length !== 1) {
          await removePublishedAvatarImage(published.path);
          console.warn("trusted_avatar_profile_update_failed", updatedProfile.status);
          return fail(
            "Не удалось подтвердить права для быстрой публикации аватара. Предыдущая фотография сохранена.",
            updatedProfile.ok ? 403 : 503,
            headers,
          );
        }

        await removePendingAvatarImage(imageUrl, userId);
        await removePreviousOwnAvatarImage(profile.avatar_url, userId);
        console.info("trusted_school_role_avatar_ai_review_skipped", JSON.stringify({ role: profile.role }));
        return respond({
          ok: true,
          status: "approved",
          avatar_url: published.url,
          avatar_review_bypassed: true,
          reason: "Аватар обновлён для подтверждённой роли без ИИ-проверки изображения.",
        }, 200, headers);
      }

      // All other roles continue through the protected private moderation queue.
      const queued = await adminRequest("rpc/enqueue_avatar_image_moderation_task", "POST", {
        p_user_id: userId,
        p_image_path: imagePath,
      });
      const queueId = typeof queued.data?.queue_id === "string" ? queued.data.queue_id : "";
      if (!queued.ok || !queueId) {
        console.error("avatar_image_moderation_enqueue_failed", queued.status);
        return fail("Не удалось сохранить фото в очередь защищённой проверки. Попробуйте ещё раз.", 503, headers);
      }

      return respond({
        ok: true,
        status: "pending",
        queue_id: queueId,
        avatar_url: profile.avatar_url ?? null,
        reason: "Фото сохранено. Оно останется приватным до проверки; предыдущий аватар продолжит отображаться.",
      }, 200, headers);
    }

    const quotaResult = await adminRequest("rpc/consume_content_quota", "POST", {
      p_user_id: userId,
      p_kind: kind,
    });
    if (!quotaResult.ok) {
      console.error("Content quota check failed:", quotaResult.status);
      return fail("Не удалось проверить лимит отправки. Попробуйте позже.", 503, headers);
    }
    if (quotaResult.data !== true) {
      return respond({ ok: false, error: "Слишком много отправок. Попробуйте позже." }, 200, headers);
    }

    if (kind === "listing") {
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      const description = typeof payload.description === "string" ? payload.description.trim() : "";
      const category = typeof payload.category === "string" ? payload.category : "";
      const priceText = typeof payload.price_text === "string" ? payload.price_text.trim() : "Бесплатно";
      const imageUrl = typeof payload.image_url === "string" ? payload.image_url : null;
      const isEvent = category === "Мероприятия";
      const eventType = payload.event_type ?? "open";
      const maxSeats = Number(payload.max_seats ?? 0);

      if (!title || title.length > 80) return fail("Заголовок должен содержать от 1 до 80 символов.", 400, headers);
      if (!description || description.length > 1000) return fail("Описание должно содержать от 1 до 1000 символов.", 400, headers);
      if (!CATEGORIES.has(category)) return fail("Недопустимая категория объявления.", 400, headers);
      if (priceText.length > 50) return fail("Поле цены слишком длинное.", 400, headers);

      if (isEvent) {
        if (!["council_member", "school_admin"].includes(profile.role) || !profile.school_id) {
          return fail("Публиковать мероприятия могут только участники Ученического совета и администраторы своей школы.", 403, headers);
        }
        if (!["open", "request", "limited"].includes(eventType)) return fail("Недопустимый тип мероприятия.", 400, headers);
        if (eventType === "limited" && (!Number.isInteger(maxSeats) || maxSeats < 1 || maxSeats > 500)) {
          return fail("Укажите корректное количество мест.", 400, headers);
        }
      }

      if (imageUrl !== null && !pendingListingImagePath(imageUrl, userId)) {
        return fail("Фото должно быть загружено в защищённое временное хранилище FAM.", 400, headers);
      }

      // Only use the server-loaded profile (never a role supplied by the browser).
      // Verified school admins and council members skip AI image review for listings,
      // while the regular text moderation and all storage/path validation still apply.
      const bypassPhotoAiReview = canSkipListingImageReview(profile, imageUrl);
      if (bypassPhotoAiReview) {
        console.info("trusted_listing_photo_ai_review_skipped", JSON.stringify({ role: profile.role }));
      }

      const moderation = await moderate(
        title + "\n" + description + "\n" + priceText,
        authorization,
        origin,
        false,
        bypassPhotoAiReview ? null : imageUrl,
        { kind: "listing", sender_id: userId, school_id: profile.school_id },
      );
      if (!moderation) return fail("Сервис модерации недоступен. Объявление не опубликовано.", 503, headers);
      if (moderation.action === "reject") {
        if (imageUrl) await removePendingListingImage(imageUrl, userId);
        return respond({ ok: false, status: "rejected", reason: moderation.reason ?? "Текст или фотография не прошли проверку.", reason_code: moderation.reason_code ?? null }, 200, headers);
      }
      const retryableImageReview = new Set([
        "image_review_rate_limited",
        "image_review_quota_exceeded",
        "image_review_unavailable",
        "image_review_no_decision",
        "openai_rate_limited",
        "openai_unavailable",
        "openai_invalid_response",
        "moderation_internal_error",
      ]);
      const retryableDiagnostics = new Set([
        "openai_rate_limited",
        "openai_unavailable",
        "openai_invalid_response",
        "moderation_internal_error",
        "missing_api_key",
      ]);
      const shouldQueueImageReview = Boolean(imageUrl)
        && !bypassPhotoAiReview
        && moderation.action === "pending"
        && (
          moderation.degraded === true
          || retryableImageReview.has(moderation.reason_code ?? "")
          || retryableDiagnostics.has(moderation.diagnostic_code ?? "")
        );

      if (shouldQueueImageReview) {
        const imagePath = pendingListingImagePath(imageUrl, userId);
        if (!imagePath) {
          await removePendingListingImage(imageUrl, userId);
          return fail("Не удалось сохранить фото для повторной проверки. Выберите его ещё раз.", 400, headers);
        }

        const queued = await adminRequest("rpc/enqueue_listing_image_moderation_task", "POST", {
          p_user_id: userId,
          p_title: title,
          p_description: description,
          p_category: category,
          p_price_text: priceText || "Бесплатно",
          p_school_id: profile.school_id,
          p_image_path: imagePath,
          p_is_event: isEvent,
          p_event_date: isEvent && typeof payload.event_date === "string" ? payload.event_date : null,
          p_event_time: isEvent && typeof payload.event_time === "string" ? payload.event_time : null,
          p_event_type: isEvent ? eventType : null,
          p_max_seats: isEvent && eventType === "limited" ? maxSeats : 0,
        });
        const listingId = typeof queued.data?.listing_id === "string" ? queued.data.listing_id : "";
        if (!queued.ok || !listingId) {
          await removePendingListingImage(imageUrl, userId);
          console.error("listing_image_moderation_enqueue_failed", queued.status);
          return fail("Не удалось сохранить объявление в очередь проверки. Попробуйте отправить ещё раз.", 503, headers);
        }

        const savedListing = await adminRequest(
          "listings?select=*&id=eq." + encodeURIComponent(listingId)
            + "&user_id=eq." + encodeURIComponent(userId) + "&limit=1",
        );
        const pendingListing = Array.isArray(savedListing.data) ? savedListing.data[0] : null;
        const imageQuotaExceeded = moderation.reason_code === "image_review_quota_exceeded"
          || moderation.diagnostic_code === "image_review_quota_exceeded";
        const photoReviewMessage = imageQuotaExceeded
          ? "Объявление сохранено без фото: сервис автоматической проверки фотографий временно исчерпал квоту. Фото загружено и хранится приватно, но не будет показано до успешной проверки. FAM повторит проверку автоматически — повторно загружать фото или отправлять объявление не нужно."
          : "Объявление сохранено без фото. Фото загружено в закрытое хранилище и будет автоматически проверяться повторно. До успешной проверки оно не отображается; повторно отправлять объявление не нужно.";

        return respond({
          ok: true,
          status: "pending",
          listing: pendingListing,
          reason: photoReviewMessage,
        }, 200, headers);
      }

      if (moderation.degraded) {
        if (imageUrl) await removePendingListingImage(imageUrl, userId);
        return respond({
          ok: false,
          status: "pending",
          degraded: true,
          error: "ИИ-модерация временно недоступна. Объявление не опубликовано — попробуйте позже.",
        }, 200, headers);
      }
      if (moderation.action === "pending") {
        if (imageUrl) await removePendingListingImage(imageUrl, userId);
        return respond({
          ok: false,
          status: "pending",
          reason_code: moderation.reason_code ?? null,
          error: moderation.reason ?? "Объявление пока не опубликовано: нужна дополнительная проверка. Загрузите другое фото или обратитесь к администратору школы.",
        }, 200, headers);
      }

      let publishedImageUrl: string | null = null;
      let publishedImagePath: string | null = null;
      if (imageUrl) {
        const publishedImage = await publishPendingListingImage(imageUrl, userId);
        publishedImageUrl = publishedImage.url;
        publishedImagePath = publishedImage.path;
      }

      const status = "active";
      const insertRow = {
        user_id: userId,
        title,
        description,
        category,
        price_text: priceText || "Бесплатно",
        image_url: publishedImageUrl,
        photo_status: publishedImageUrl ? "approved" : "none",
        status,
        is_event: isEvent,
        school_id: profile.school_id,
        event_date: isEvent && typeof payload.event_date === "string" ? payload.event_date : null,
        event_time: isEvent && typeof payload.event_time === "string" ? payload.event_time : null,
        event_type: isEvent ? eventType : null,
        max_seats: isEvent && eventType === "limited" ? maxSeats : 0,
      };

      const insertResult = await adminRequest("listings?select=*", "POST", insertRow);
      const listing = Array.isArray(insertResult.data) ? insertResult.data[0] : null;
      if (!insertResult.ok || !listing) {
        if (publishedImagePath) await removePublishedListingImage(publishedImagePath);
        console.error("Listing insert failed:", insertResult.status);
        return fail("Не удалось сохранить объявление.", 500, headers);
      }

      return respond({
        ok: true,
        status: moderation.action === "pending" ? "pending" : "approved",
        listing,
        photo_review_bypassed: bypassPhotoAiReview,
        reason: bypassPhotoAiReview
          ? "Фото опубликовано без ИИ-проверки изображения для подтверждённой роли. Текст объявления прошёл обычную проверку FAM."
          : moderation.reason ?? null,
      }, 200, headers);
    }

    if (kind === "idea") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text.length < 2 || text.length > 1000) return fail("Идея должна содержать от 2 до 1000 символов.", 400, headers);
      if (!profile.school_id) return fail("Укажите школу в профиле перед отправкой идеи.", 400, headers);

      const submittedImages = Array.isArray(payload.image_urls) ? payload.image_urls : [];
      if (submittedImages.length > 3 || submittedImages.some((image) => typeof image !== "string")) {
        return fail("Можно приложить не больше 3 фотографий.", 400, headers);
      }
      const imageUrls = [...new Set(submittedImages as string[])];
      if (imageUrls.length !== submittedImages.length) return fail("Удалите повторяющиеся фотографии.", 400, headers);
      const pendingPaths = imageUrls.map((imageUrl) => pendingListingImagePath(imageUrl, userId));
      if (pendingPaths.some((path) => !path)) {
        return fail("Фото должно быть загружено в защищённое временное хранилище FAM.", 400, headers);
      }

      const safetyContext = {
        kind: "idea" as const,
        sender_id: userId,
        school_id: profile.school_id,
      };
      let moderation = await moderate(text, authorization, origin, true, null, safetyContext);
      if (!moderation) return fail("Сервис модерации недоступен. Идея не отправлена.", 503, headers);
      if (moderation.action === "reject") {
        await Promise.all(imageUrls.map((url) => removePendingListingImage(url, userId)));
        return respond({ ok: false, status: "rejected", reason: moderation.reason ?? "Текст не прошёл проверку.", reason_code: moderation.reason_code ?? null }, 200, headers);
      }
      if (imageUrls.length && moderation.action === "pending") {
        await Promise.all(imageUrls.map((url) => removePendingListingImage(url, userId)));
        return respond({
          ok: false,
          status: "pending",
          reason: "Текст идеи ожидает проверки. Отправьте предложение без фото или попробуйте позже.",
        }, 200, headers);
      }

      for (const imageUrl of imageUrls) {
        moderation = await moderate(text, authorization, origin, true, imageUrl, safetyContext);
        if (moderation.action !== "ok") {
          await Promise.all(imageUrls.map((url) => removePendingListingImage(url, userId)));
          return respond({
            ok: false,
            status: moderation.action,
            reason: moderation.action === "pending"
              ? "Фото не удалось проверить. Идея не отправлена; попробуйте позже или отправьте её без фото."
              : moderation.reason ?? "Фото не прошло проверку безопасности.",
            reason_code: moderation.reason_code ?? null,
          }, 200, headers);
        }
      }

      const publishedImagePaths: string[] = [];
      try {
        for (const imageUrl of imageUrls) {
          publishedImagePaths.push(await publishPendingIdeaImage(imageUrl, userId));
        }
      } catch (error) {
        await Promise.all(publishedImagePaths.map((path) => removePublishedIdeaImage(path)));
        await Promise.all(imageUrls.map((url) => removePendingListingImage(url, userId)));
        return fail(error instanceof Error ? error.message : "Не удалось сохранить фотографии.", 503, headers);
      }

      const insertResult = await adminRequest("ideas?select=*", "POST", {
        user_id: userId,
        school_id: profile.school_id,
        text,
        image_paths: publishedImagePaths,
        ai_status: moderation.action === "pending" ? "pending" : "approved",
        ai_summary: text.slice(0, 60),
        ai_reason: moderation.reason ?? null,
        admin_status: "new",
      });
      const idea = Array.isArray(insertResult.data) ? insertResult.data[0] : null;

      if (!insertResult.ok || !idea) {
        await Promise.all(publishedImagePaths.map((path) => removePublishedIdeaImage(path)));
        console.error("Idea insert failed:", insertResult.status);
        return fail("Не удалось сохранить идею.", 500, headers);
      }

      return respond({
        ok: true,
        status: moderation.action,
        degraded: moderation.degraded === true,
        diagnostic_code: moderation.diagnostic_code ?? null,
        idea,
        reason: moderation.reason ?? null,
      }, 200, headers);
    }

    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    const receiverId = typeof payload.receiver_id === "string" ? payload.receiver_id : "";
    if (body.length < 1 || body.length > 1000) return fail("Сообщение должно содержать от 1 до 1000 символов.", 400, headers);
    if (!UUID_RE.test(receiverId) || receiverId === userId) return fail("Некорректный получатель сообщения.", 400, headers);

    const recipientResult = await adminRequest(
      "profiles?select=id&id=eq." + encodeURIComponent(receiverId) + "&limit=1",
    );
    const recipient = Array.isArray(recipientResult.data) ? recipientResult.data[0] : null;
    if (!recipientResult.ok || !recipient) return fail("Получатель не найден.", 404, headers);

    const listingId = typeof payload.listing_id === "string" ? payload.listing_id : null;
    if (listingId) {
      if (!UUID_RE.test(listingId)) return fail("Некорректное объявление для переписки.", 400, headers);
      const listingResult = await adminRequest("listings?select=id,school_id&id=eq." + encodeURIComponent(listingId) + "&limit=1");
      const listing = Array.isArray(listingResult.data) ? listingResult.data[0] : null;
      if (!listing || listing.school_id !== profile.school_id) return fail("Объявление для переписки не найдено.", 404, headers);
    }

    const moderation = await moderate(body, authorization, origin, false, null, {
      kind: "message",
      sender_id: userId,
      receiver_id: receiverId,
      school_id: profile.school_id,
    });
    if (!moderation) return fail("Сервис модерации недоступен. Сообщение не отправлено.", 503, headers);
    if (moderation.action !== "ok") {
      return respond({
        ok: false,
        status: moderation.action === "pending" ? "pending" : "rejected",
        degraded: moderation.degraded === true,
        reason: moderation.reason ?? (moderation.action === "pending"
          ? "Сообщение не отправлено: требуется дополнительная проверка."
          : "Сообщение не прошло проверку."),
        reason_code: moderation.reason_code ?? null,
      }, 200, headers);
    }

    const insertResult = await adminRequest("messages?select=*", "POST", {
      sender_id: userId,
      receiver_id: receiverId,
      listing_id: listingId,
      body,
      is_read: false,
    });
    const message = Array.isArray(insertResult.data) ? insertResult.data[0] : null;
    if (!insertResult.ok || !message) {
      console.error("Message insert failed:", insertResult.status);
      return fail("Не удалось отправить сообщение.", 500, headers);
    }

    return respond({ ok: true, status: "approved", message }, 200, headers);
  } catch (error) {
    console.error("submit-content failed:", error instanceof Error ? error.message : "unknown error");
    return fail("Не удалось обработать отправку. Попробуйте позже.", 500, headers);
  }
});