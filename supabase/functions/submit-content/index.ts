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

async function moderate(
  text: string,
  authorization: string,
  origin: string | null,
  rulesOnly = false,
): Promise<{ action: "ok" | "pending" | "reject"; reason?: string; degraded?: boolean; diagnostic_code?: string; reason_code?: string }> {
  let response: Response;
  try {
    response = await fetch(SUPABASE_URL + "/functions/v1/moderate", {
      method: "POST",
      headers: {
        "Authorization": authorization,
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        ...(origin && ALLOWED_ORIGINS.has(origin) ? { "Origin": origin } : {}),
      },
      body: JSON.stringify({ text, rules_only: rulesOnly }),
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
      "profiles?select=id,school_id,role&id=eq." + encodeURIComponent(userId) + "&limit=1",
    );
    const profile = Array.isArray(profileResult.data) ? profileResult.data[0] : null;
    if (!profileResult.ok || !profile) return fail("Профиль пользователя не найден.", 403, headers);

    const kind = payload.kind;
    if (!["listing", "idea", "message"].includes(kind)) return fail("Неизвестный тип отправки.", 400, headers);

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
        if (profile.role !== "school_admin") return fail("Создавать мероприятия может только школьный совет.", 403, headers);
        if (!["open", "request", "limited"].includes(eventType)) return fail("Недопустимый тип мероприятия.", 400, headers);
        if (eventType === "limited" && (!Number.isInteger(maxSeats) || maxSeats < 1 || maxSeats > 500)) {
          return fail("Укажите корректное количество мест.", 400, headers);
        }
      }

      if (imageUrl !== null) {
        const requiredPrefix = SUPABASE_URL + "/storage/v1/object/public/listings-images/listing_" + userId + "_";
        if (!imageUrl.startsWith(requiredPrefix) || imageUrl.length > 1200) {
          return fail("Фото должно быть загружено в личную папку FAM.", 400, headers);
        }
      }

      const moderation = await moderate(title + "\n" + description + "\n" + priceText, authorization, origin);
      if (!moderation) return fail("Сервис модерации недоступен. Объявление не опубликовано.", 503, headers);
      if (moderation.action === "reject") {
        return respond({ ok: false, status: "rejected", reason: moderation.reason ?? "Текст не прошёл проверку.", reason_code: moderation.reason_code ?? null }, 200, headers);
      }
      if (moderation.degraded) {
        return respond({
          ok: false,
          status: "pending",
          degraded: true,
          error: "ИИ-модерация временно недоступна. Объявление не опубликовано — попробуйте позже.",
        }, 200, headers);
      }
      if (moderation.action === "pending") {
        return respond({
          ok: false,
          status: "pending",
          error: "Объявление пока не опубликовано: текст требует дополнительной проверки. Измените формулировку и попробуйте ещё раз.",
        }, 200, headers);
      }

      const status = "active";
      const insertRow = {
        user_id: userId,
        title,
        description,
        category,
        price_text: priceText || "Бесплатно",
        image_url: imageUrl,
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
        console.error("Listing insert failed:", insertResult.status);
        return fail("Не удалось сохранить объявление.", 500, headers);
      }

      return respond({
        ok: true,
        status: moderation.action === "pending" ? "pending" : "approved",
        listing,
        reason: moderation.reason ?? null,
      }, 200, headers);
    }

    if (kind === "idea") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text.length < 2 || text.length > 1000) return fail("Идея должна содержать от 2 до 1000 символов.", 400, headers);
      if (!profile.school_id) return fail("Укажите школу в профиле перед отправкой идеи.", 400, headers);

      const moderation = await moderate(text, authorization, origin, true);
      if (!moderation) return fail("Сервис модерации недоступен. Идея не отправлена.", 503, headers);
      if (moderation.action === "reject") {
        return respond({ ok: false, status: "rejected", reason: moderation.reason ?? "Текст не прошёл проверку.", reason_code: moderation.reason_code ?? null }, 200, headers);
      }

      const insertResult = await adminRequest("ideas?select=*", "POST", {
        user_id: userId,
        school_id: profile.school_id,
        text,
        ai_status: moderation.action === "pending" ? "pending" : "approved",
        ai_summary: text.slice(0, 60),
        ai_reason: moderation.reason ?? null,
        admin_status: "new",
      });
      const idea = Array.isArray(insertResult.data) ? insertResult.data[0] : null;

      if (!insertResult.ok || !idea) {
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

    const moderation = await moderate(body, authorization, origin);
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
