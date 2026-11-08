import { isAllowedApplicantNote, mapSchoolAdminRequests } from "./access-controls.js";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function readDefaultKey(variable: string): string {
  const raw = Deno.env.get(variable) ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    // Older projects use plain environment-variable values.
  }
  return raw;
}

const PUBLISHABLE_KEY =
  readDefaultKey("SUPABASE_PUBLISHABLE_KEYS") ||
  Deno.env.get("SUPABASE_ANON_KEY") ||
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
  "";

const SECRET_KEY =
  readDefaultKey("SUPABASE_SECRET_KEYS") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SECRET_KEY") ||
  "";

const SECRET_IS_JWT = SECRET_KEY.startsWith("eyJ");
const ALLOWED_ORIGINS = new Set([
  "https://spartakdubov059.github.io",
  "https://mellifluous-profiterole-48c13b.netlify.app",
]);
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

function json(body: Record<string, unknown>, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function adminRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = {
    "apikey": SECRET_KEY,
    "Content-Type": "application/json",
  };
  if (SECRET_IS_JWT) headers["Authorization"] = "Bearer " + SECRET_KEY;
  if (method !== "GET") headers["Prefer"] = "return=representation";

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

async function getProfile(userId: string): Promise<any | null> {
  const result = await adminRequest(
    "profiles?select=id,school_id,role&id=eq." + encodeURIComponent(userId) + "&limit=1",
  );
  return result.ok && Array.isArray(result.data) ? result.data[0] ?? null : null;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ ok: false, error: "Источник запроса не разрешён." }, 403, headers);
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false, error: "Метод запроса не поддерживается." }, 405, headers);

  if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
    return json({ ok: false, error: "Сервер обработки заявок не настроен." }, 503, headers);
  }

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authorization)) {
    return json({ ok: false, error: "Войдите в аккаунт." }, 401, headers);
  }

  try {
    const authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": PUBLISHABLE_KEY, "Authorization": authorization },
    });
    if (!authResponse.ok) return json({ ok: false, error: "Сессия недействительна. Войдите заново." }, 401, headers);
    const authUser = await authResponse.json().catch(() => null);
    const userId = typeof authUser?.id === "string" ? authUser.id : "";
    if (!UUID_RE.test(userId)) return json({ ok: false, error: "Не удалось подтвердить пользователя." }, 401, headers);

    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 8_192) {
      return json({ ok: false, error: "Запрос слишком большой." }, 413, headers);
    }
    let payload: any;
    try { payload = JSON.parse(raw); } catch {
      return json({ ok: false, error: "Некорректный формат запроса." }, 400, headers);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ ok: false, error: "Некорректный запрос." }, 400, headers);
    }

    const profile = await getProfile(userId);
    if (!profile) return json({ ok: false, error: "Профиль пользователя не найден." }, 403, headers);

    const action = payload.action;

    if (action === "status") {
      if (profile.role === "school_admin") {
        if (!profile.school_id) return json({ ok: false, error: "У аккаунта не указана школа." }, 403, headers);
        const result = await adminRequest(
          "rpc/list_school_admin_requests",
          "POST",
          { p_reviewer_id: userId },
        );
        if (!result.ok) {
          console.error("school_admin_requests_list_failed", result.status);
          return json({ ok: false, error: "Не удалось загрузить заявки." }, 503, headers);
        }
        return json({ ok: true, role: "school_admin", requests: mapSchoolAdminRequests(result.data) }, 200, headers);
      }

      const own = await adminRequest(
        "school_admin_requests?select=id,school_id,applicant_note,status,created_at,review_started_at,reviewed_at,review_note&user_id=eq."
        + encodeURIComponent(userId)
        + "&order=created_at.desc&limit=1",
      );
      if (!own.ok) return json({ ok: false, error: "Не удалось загрузить статус заявки." }, 503, headers);
      const ownRequest = Array.isArray(own.data) ? own.data[0] ?? null : null;
      if (ownRequest?.applicant_note === "Член Ученического совета") {
        ownRequest.applicant_note = "Участник Ученического совета";
      }
      return json({
        ok: true,
        role: profile.role,
        request: ownRequest,
      }, 200, headers);
    }

    if (action === "request") {
      if (profile.role !== "student") return json({ ok: false, error: "Подать заявку может только ученический аккаунт без прав Совета." }, 403, headers);
      if (!profile.school_id) return json({ ok: false, error: "Сначала укажите школу в профиле." }, 400, headers);
      if (!authUser.email_confirmed_at) {
        return json({ ok: false, error: "Сначала подтвердите электронную почту аккаунта." }, 403, headers);
      }

      const note = typeof payload.applicant_note === "string" ? payload.applicant_note.trim() : "";
      if (!isAllowedApplicantNote(note)) {
        return json({ ok: false, error: "Выберите одну из двух ролей: участник Совета или администратор." }, 400, headers);
      }

      const school = await adminRequest(
        "schools?select=id,name&id=eq." + encodeURIComponent(profile.school_id) + "&limit=1",
      );
      if (!school.ok || !Array.isArray(school.data) || !school.data[0]) {
        return json({ ok: false, error: "Школа аккаунта не найдена. Обратитесь к администратору FAM." }, 400, headers);
      }

      const existing = await adminRequest(
        "school_admin_requests?select=id,status,created_at,review_started_at&user_id=eq."
        + encodeURIComponent(userId) + "&status=in.(pending,reviewing)&limit=1",
      );
      if (!existing.ok) return json({ ok: false, error: "Не удалось проверить предыдущую заявку." }, 503, headers);
      if (Array.isArray(existing.data) && existing.data[0]) {
        return json({ ok: true, already_pending: true, request: existing.data[0] }, 200, headers);
      }

      const insert = await adminRequest("school_admin_requests?select=id,status,created_at", "POST", {
        user_id: userId,
        school_id: profile.school_id,
        applicant_note: note,
        status: "pending",
      });
      if (!insert.ok) {
        if (insert.status === 409 || insert.status === 400) {
          const existing = await adminRequest(
            "school_admin_requests?select=id,status,created_at,review_started_at&user_id=eq." + encodeURIComponent(userId)
            + "&status=in.(pending,reviewing)&limit=1",
          );
          if (existing.ok && Array.isArray(existing.data) && existing.data[0]) {
            return json({ ok: true, already_pending: true, request: existing.data[0] }, 200, headers);
          }
        }
        console.error("school_admin_request_insert_failed", insert.status);
        return json({ ok: false, error: "Не удалось создать заявку. Попробуйте позже." }, 503, headers);
      }
      const created = Array.isArray(insert.data) ? insert.data[0] : null;
      return json({ ok: true, request: created }, 200, headers);
    }

    if (action === "start_review") {
      if (profile.role !== "school_admin" || !profile.school_id) {
        return json({ ok: false, error: "Взять заявку на рассмотрение может только Совет своего лицея." }, 403, headers);
      }
      const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
      if (!UUID_RE.test(requestId)) return json({ ok: false, error: "Некорректный номер заявки." }, 400, headers);

      const result = await adminRequest("rpc/start_school_admin_request_review", "POST", {
        p_request_id: requestId,
        p_reviewer_id: userId,
      });
      if (!result.ok) {
        const message = result.data?.message || result.data?.details || "Не удалось взять заявку на рассмотрение.";
        return json({ ok: false, error: String(message).slice(0, 200) }, result.status === 403 ? 403 : 409, headers);
      }
      return json({ ok: true, result: result.data }, 200, headers);
    }

    if (action === "review") {
      if (profile.role !== "school_admin" || !profile.school_id) {
        return json({ ok: false, error: "Рассматривать заявки может только действующий администратор своего лицея." }, 403, headers);
      }
      const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
      const decision = payload.decision;
      if (!UUID_RE.test(requestId) || !["approve", "reject"].includes(decision)) {
        return json({ ok: false, error: "Некорректные данные решения." }, 400, headers);
      }
      const note = typeof payload.review_note === "string" ? payload.review_note.trim().slice(0, 240) : "";
      const result = await adminRequest("rpc/review_school_admin_request", "POST", {
        p_request_id: requestId,
        p_reviewer_id: userId,
        p_approve: decision === "approve",
        p_note: note || null,
      });
      if (!result.ok) {
        console.warn("school_admin_request_review_failed", result.status);
        const message = result.data?.message || result.data?.details || "Не удалось обработать заявку.";
        return json({ ok: false, error: String(message).slice(0, 200) }, result.status === 403 ? 403 : 400, headers);
      }
      return json({ ok: true, result: result.data }, 200, headers);
    }

    return json({ ok: false, error: "Неизвестное действие." }, 400, headers);
  } catch (error) {
    console.error("school_admin_access_failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false, error: "Внутренняя ошибка. Попробуйте позже." }, 500, headers);
  }
});
