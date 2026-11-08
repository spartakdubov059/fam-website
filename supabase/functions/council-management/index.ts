const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function readKey(variable: string): string {
  const raw = Deno.env.get(variable) ?? "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.default === "string") return parsed.default;
  } catch {
    // Older projects store a plain string.
  }
  return raw;
}

const PUBLISHABLE_KEY =
  readKey("SUPABASE_PUBLISHABLE_KEYS") ||
  Deno.env.get("SUPABASE_ANON_KEY") ||
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
  "";

const SECRET_KEY =
  readKey("SUPABASE_SECRET_KEYS") ||
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

function maskEmail(value: unknown): string {
  if (typeof value !== "string") return "Пользователь";
  const email = value.trim();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "Пользователь";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain || /[\s<>]/u.test(domain)) return "Пользователь";
  return local.slice(0, 1) + "***@" + domain;
}

function serviceHeaders(contentType = true): Record<string, string> {
  const headers: Record<string, string> = { "apikey": SECRET_KEY };
  if (SECRET_IS_JWT) headers["Authorization"] = "Bearer " + SECRET_KEY;
  if (contentType) headers["Content-Type"] = "application/json";
  return headers;
}

async function adminRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: {
      ...serviceHeaders(),
      ...(method !== "GET" ? { "Prefer": "return=representation" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data: any = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  return { ok: response.ok, status: response.status, data };
}

async function storageList(bucket: string, prefix: string, search?: string): Promise<string[]> {
  const paths: string[] = [];
  let offset = 0;
  while (true) {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/list/" + encodeURIComponent(bucket), {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify({
        prefix,
        ...(search ? { search } : {}),
        limit: 1000,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    });
    if (!response.ok) {
      const diagnostic = await response.text();
      console.warn("storage_list_failed", bucket, response.status, diagnostic.slice(0, 160));
      throw new Error("Не удалось подготовить файлы аккаунта к удалению.");
    }
    const rows = await response.json().catch(() => []);
    if (!Array.isArray(rows)) break;
    const files = rows
      .filter((row: any) => row && typeof row.name === "string" && row.name.length > 0 && (typeof row.id === "string" || row.metadata != null))
      .map((row: any) => prefix + row.name);
    paths.push(...files);
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return paths;
}

async function storageRemove(bucket: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  for (let offset = 0; offset < paths.length; offset += 1000) {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + encodeURIComponent(bucket), {
      method: "DELETE",
      headers: serviceHeaders(),
      body: JSON.stringify({ prefixes: paths.slice(offset, offset + 1000) }),
    });
    if (!response.ok) {
      const diagnostic = await response.text();
      console.warn("storage_remove_failed", bucket, response.status, diagnostic.slice(0, 160));
      throw new Error("Не удалось удалить файлы аккаунта из хранилища.");
    }
  }
}

async function recordAudit(
  schoolId: string,
  actorId: string,
  targetId: string | null,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const result = await adminRequest("council_admin_audit", "POST", {
    school_id: schoolId,
    actor_id: actorId,
    target_id: targetId,
    action,
    details,
  });
  if (!result.ok) {
    console.error("council_admin_audit_write_failed", result.status, action);
    throw new Error("Не удалось записать действие в журнал. Операция отменена.");
  }
}

async function getSchoolProfile(userId: string): Promise<any | null> {
  const result = await adminRequest(
    "profiles?select=id,school_id,role,email,created_at&id=eq." + encodeURIComponent(userId) + "&limit=1",
  );
  return result.ok && Array.isArray(result.data) ? result.data[0] ?? null : null;
}

async function listOverview(schoolId: string): Promise<Record<string, unknown>> {
  const [users, listings, audit] = await Promise.all([
    adminRequest(
      "profiles?select=id,email,role,created_at&school_id=eq." + encodeURIComponent(schoolId)
      + "&order=created_at.desc&limit=100",
    ),
    adminRequest(
      "listings?select=id,title,category,user_id,status,is_event,created_at&school_id=eq."
      + encodeURIComponent(schoolId) + "&order=created_at.desc&limit=40",
    ),
    adminRequest(
      "council_admin_audit?select=id,actor_id,target_id,action,details,created_at&school_id=eq."
      + encodeURIComponent(schoolId) + "&order=created_at.desc&limit=20",
    ),
  ]);

  if (!users.ok || !listings.ok || !audit.ok) {
    console.error("council_overview_failed", users.status, listings.status, audit.status);
    throw new Error("Не удалось загрузить панель управления.");
  }

  return {
    users: (users.data ?? []).map((row: any) => ({
      id: row.id,
      email: maskEmail(row.email),
      role: row.role,
      created_at: row.created_at,
    })),
    listings: (listings.data ?? []).map((row: any) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      user_id: row.user_id,
      status: row.status,
      is_event: row.is_event === true,
      created_at: row.created_at,
    })),
    audit: (audit.data ?? []).map((row: any) => ({
      id: row.id,
      actor: typeof row.actor_id === "string" ? row.actor_id.slice(0, 8) : "",
      target: typeof row.target_id === "string" ? row.target_id.slice(0, 8) : "",
      action: row.action,
      details: row.details ?? {},
      created_at: row.created_at,
    })),
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "Источник запроса не разрешён." }, 403, headers);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false, error: "Метод запроса не поддерживается." }, 405, headers);
  if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
    return json({ ok: false, error: "Сервер управления школой не настроен." }, 503, headers);
  }

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authorization)) return json({ ok: false, error: "Войдите в аккаунт." }, 401, headers);

  try {
    const authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": PUBLISHABLE_KEY, "Authorization": authorization },
    });
    if (!authResponse.ok) return json({ ok: false, error: "Сессия недействительна. Войдите заново." }, 401, headers);
    const authUser = await authResponse.json().catch(() => null);
    const actorId = typeof authUser?.id === "string" ? authUser.id : "";
    if (!UUID_RE.test(actorId)) return json({ ok: false, error: "Не удалось подтвердить пользователя." }, 401, headers);

    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 8_192) return json({ ok: false, error: "Запрос слишком большой." }, 413, headers);
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: "Некорректный формат запроса." }, 400, headers); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ ok: false, error: "Некорректный запрос." }, 400, headers);

    const actor = await getSchoolProfile(actorId);
    if (!actor) return json({ ok: false, error: "Профиль пользователя не найден." }, 403, headers);
    if (actor.role !== "school_admin" || !actor.school_id) {
      return json({ ok: false, error: "Эта панель доступна только администратору своей школы." }, 403, headers);
    }

    const action = payload.action;
    if (action === "overview") {
      return json({ ok: true, ...(await listOverview(actor.school_id)) }, 200, headers);
    }

    const targetId = typeof payload.target_id === "string" ? payload.target_id : "";
    if (!UUID_RE.test(targetId)) return json({ ok: false, error: "Некорректный идентификатор." }, 400, headers);

    if (action === "revoke_role") {
      const result = await adminRequest("rpc/revoke_council_role", "POST", {
        p_actor_id: actorId,
        p_target_id: targetId,
      });
      if (!result.ok) {
        const message = result.data?.message || result.data?.details || "Не удалось снять полномочия.";
        return json({ ok: false, error: String(message).slice(0, 220) }, result.status === 403 ? 403 : 409, headers);
      }
      return json({ ok: true, result: result.data }, 200, headers);
    }

    if (action === "delete_listing") {
      const found = await adminRequest(
        "listings?select=id,title,user_id,school_id,image_url,status&id=eq."
        + encodeURIComponent(targetId) + "&limit=1",
      );
      const listing = found.ok && Array.isArray(found.data) ? found.data[0] ?? null : null;
      if (!listing) return json({ ok: false, error: "Объявление не найдено." }, 404, headers);

      let ownerSchoolId = listing.school_id;
      if (!ownerSchoolId) {
        const owner = await getSchoolProfile(listing.user_id);
        ownerSchoolId = owner?.school_id ?? null;
      }
      if (ownerSchoolId !== actor.school_id) {
        return json({ ok: false, error: "Можно удалять только объявления своей школы." }, 403, headers);
      }

      const removed = await adminRequest(
        "listings?id=eq." + encodeURIComponent(targetId),
        "DELETE",
      );
      if (!removed.ok) {
        console.error("school_listing_delete_failed", removed.status);
        return json({ ok: false, error: "Не удалось удалить объявление." }, 503, headers);
      }

      let imageCleanup = "no_image";
      if (typeof listing.image_url === "string") {
        try {
          const buckets = ["listings-images", "listing-images"];
          for (const bucket of buckets) {
            const marker = "/storage/v1/object/public/" + bucket + "/";
            const markerAt = listing.image_url.indexOf(marker);
            if (markerAt < 0) continue;
            const path = decodeURIComponent(listing.image_url.slice(markerAt + marker.length).split("?")[0]);
            const belongsToOwner = path.startsWith("listing_" + listing.user_id + "_")
              || path.startsWith(listing.user_id + "/");
            if (path && belongsToOwner) {
              await storageRemove(bucket, [path]);
              imageCleanup = "removed";
            }
            break;
          }
        } catch (error) {
          imageCleanup = "failed";
          console.warn("listing_image_cleanup_failed", error instanceof Error ? error.name : "unknown");
        }
      }

      await recordAudit(actor.school_id, actorId, listing.user_id, "listing_deleted", {
        listing_id: targetId,
        title: String(listing.title ?? "").slice(0, 100),
        image_cleanup: imageCleanup,
      });
      return json({ ok: true, image_cleanup: imageCleanup }, 200, headers);
    }

    if (action === "delete_account") {
      if (targetId === actorId) return json({ ok: false, error: "Нельзя удалить собственный аккаунт из панели." }, 403, headers);
      const target = await getSchoolProfile(targetId);
      if (!target || target.school_id !== actor.school_id) {
        return json({ ok: false, error: "Аккаунт не найден в вашей школе." }, 404, headers);
      }
      if (target.role === "school_admin") {
        return json({ ok: false, error: "Сначала снимите полномочия администратора. Последнего администратора удалить нельзя." }, 403, headers);
      }
      if (!["student", "council_member"].includes(target.role)) {
        return json({ ok: false, error: "Этот аккаунт нельзя удалить из панели." }, 403, headers);
      }

      // Auth deletion fails while the user owns Storage objects. Remove only
      // objects whose paths belong to this exact account before deleting Auth.
      const ownedObjects = [
        { bucket: "avatars", paths: await storageList("avatars", targetId + "/") },
        { bucket: "event-images", paths: await storageList("event-images", targetId + "/") },
        { bucket: "listing-images", paths: await storageList("listing-images", targetId + "/") },
        { bucket: "listings-images", paths: await storageList("listings-images", "", "listing_" + targetId + "_") },
      ];
      for (const bucket of ownedObjects) {
        await storageRemove(bucket.bucket, bucket.paths);
      }

      const deleteResponse = await fetch(
        SUPABASE_URL + "/auth/v1/admin/users/" + encodeURIComponent(targetId),
        { method: "DELETE", headers: serviceHeaders(false) },
      );
      if (!deleteResponse.ok) {
        const diagnostic = await deleteResponse.text();
        console.error("auth_user_delete_failed", deleteResponse.status, diagnostic.slice(0, 180));
        return json({ ok: false, error: "Supabase не смог удалить аккаунт. Проверьте связанные файлы или данные и повторите позже." }, 503, headers);
      }

      await recordAudit(actor.school_id, actorId, targetId, "account_deleted", {
        previous_role: target.role,
        email: maskEmail(target.email),
      });
      return json({ ok: true }, 200, headers);
    }

    return json({ ok: false, error: "Неизвестное действие." }, 400, headers);
  } catch (error) {
    console.error("council_management_failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false, error: error instanceof Error ? error.message : "Внутренняя ошибка. Попробуйте позже." }, 500, headers);
  }
});
