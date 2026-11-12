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
  "https://famru.netlify.app",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELETE_CONFIRMATION = "УДАЛИТЬ МОЙ АККАУНТ";
const REASON_CODES = new Set(["rules_violation", "harassment", "fake_account", "spam", "other"]);

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
      console.error("storage_remove_failed", bucket, response.status, diagnostic.slice(0, 180));
      throw new Error("Не удалось очистить фотографии аккаунта. Аккаунт не удалён.");
    }
  }
}

async function deleteAccountCompletely(userId: string, preserveRequestId: string | null = null): Promise<void> {
  if (!UUID_RE.test(userId)) throw new Error("Некорректный аккаунт для удаления.");

  // This server-only RPC returns owned objects and legacy FAM paths.
  const storageResult = await adminRequest("rpc/list_account_storage_objects", "POST", {
    p_user_id: userId,
  });
  if (!storageResult.ok || !Array.isArray(storageResult.data)) {
    console.error("account_storage_inventory_failed", storageResult.status);
    throw new Error("Не удалось проверить все файлы аккаунта. Удаление остановлено.");
  }

  const grouped = new Map<string, string[]>();
  for (const row of storageResult.data) {
    if (typeof row?.bucket_id !== "string" || typeof row?.object_name !== "string") continue;
    if (!/^[a-z0-9_-]{1,100}$/i.test(row.bucket_id) || !row.object_name || row.object_name.length > 1024) continue;
    const current = grouped.get(row.bucket_id) ?? [];
    current.push(row.object_name);
    grouped.set(row.bucket_id, current);
  }

  for (const [bucket, paths] of grouped.entries()) {
    await storageRemove(bucket, paths);
  }

  // Confirm that no object still owned by this user prevents Auth deletion.
  const verifyStorage = await adminRequest("rpc/list_account_storage_objects", "POST", {
    p_user_id: userId,
  });
  if (!verifyStorage.ok || !Array.isArray(verifyStorage.data) || verifyStorage.data.length > 0) {
    console.error("account_storage_cleanup_incomplete", verifyStorage.status);
    throw new Error("Не удалось полностью очистить файлы аккаунта. Удаление остановлено.");
  }

  // Remember open requests to close only after Auth confirms the account deletion.
  const openRequestFilter = "account_deletion_requests?select=id&target_id=eq."
    + encodeURIComponent(userId) + "&status=in.(pending,processing)"
    + (preserveRequestId ? "&id=neq." + encodeURIComponent(preserveRequestId) : "");
  const openRequests = await adminRequest(openRequestFilter);
  if (!openRequests.ok || !Array.isArray(openRequests.data)) {
    console.error("account_deletion_request_inventory_failed", openRequests.status);
    throw new Error("Не удалось проверить связанные обращения. Удаление остановлено.");
  }

  // Remove masked contact snapshots from open or historical deletion requests.
  const requesterScrub = await adminRequest(
    "account_deletion_requests?requester_id=eq." + encodeURIComponent(userId),
    "PATCH",
    { requester_email_masked: null },
  );
  const targetScrub = await adminRequest(
    "account_deletion_requests?target_id=eq." + encodeURIComponent(userId),
    "PATCH",
    { target_email_masked: null },
  );
  if (!requesterScrub.ok || !targetScrub.ok) {
    console.error("account_deletion_snapshot_cleanup_failed", requesterScrub.status, targetScrub.status);
    throw new Error("Не удалось очистить связанные данные о заявках. Аккаунт не удалён.");
  }

  const deleteResponse = await fetch(
    SUPABASE_URL + "/auth/v1/admin/users/" + encodeURIComponent(userId),
    { method: "DELETE", headers: serviceHeaders(false) },
  );
  if (!deleteResponse.ok) {
    const diagnostic = await deleteResponse.text();
    console.error("auth_user_delete_failed", deleteResponse.status, diagnostic.slice(0, 180));
    throw new Error("Supabase не смог удалить аккаунт и связанные записи. Попробуйте позже.");
  }

  const openRequestIds = openRequests.data
    .map((row: any) => row?.id)
    .filter((id: unknown): id is string => typeof id === "string" && UUID_RE.test(id));
  if (openRequestIds.length) {
    const cancelled = await adminRequest(
      "account_deletion_requests?id=in.(" + openRequestIds.map(encodeURIComponent).join(",")
      + ")&status=in.(pending,processing)",
      "PATCH",
      {
        status: "cancelled",
        reviewed_at: new Date().toISOString(),
        review_note: "Аккаунт удалён отдельно; обращение закрыто.",
      },
    );
    if (!cancelled.ok) {
      console.error("account_deletion_request_close_failed_after_delete", cancelled.status);
    }
  }
}

async function recordAudit(
  schoolId: string,
  actorId: string | null,
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
    throw new Error("Не удалось записать действие в журнал.");
  }
}

async function getSchoolProfile(userId: string): Promise<any | null> {
  const result = await adminRequest(
    "profiles?select=id,school_id,role,email,created_at&id=eq." + encodeURIComponent(userId) + "&limit=1",
  );
  return result.ok && Array.isArray(result.data) ? result.data[0] ?? null : null;
}

async function getActiveSuspension(userId: string): Promise<any | null> {
  const result = await adminRequest(
    "account_suspensions?select=id,school_id,target_id,target_role,duration_hours,reason,status,expires_at,created_at"
    + "&target_id=eq." + encodeURIComponent(userId)
    + "&status=eq.active&expires_at=gt." + encodeURIComponent(new Date().toISOString())
    + "&order=created_at.desc&limit=1",
  );
  if (!result.ok || !Array.isArray(result.data)) {
    throw new Error("Не удалось проверить статус ограничений аккаунта.");
  }
  return result.data[0] ?? null;
}

async function listOverview(schoolId: string): Promise<Record<string, unknown>> {
  const [users, listings, audit, deletionRequests, suspensions] = await Promise.all([
    adminRequest(
      "profiles?select=id,email,role,created_at,first_name,last_name,class_name&school_id=eq." + encodeURIComponent(schoolId)
      + "&order=created_at.desc&limit=100",
    ),
    adminRequest(
      "listings?select=id,title,description,price_text,category,user_id,status,moderation_status,is_event,event_date,city,created_at&school_id=eq."
      + encodeURIComponent(schoolId) + "&order=created_at.desc&limit=100",
    ),
    adminRequest(
      "council_admin_audit?select=id,actor_id,target_id,action,details,created_at&school_id=eq."
      + encodeURIComponent(schoolId) + "&order=created_at.desc&limit=20",
    ),
    adminRequest(
      "account_deletion_requests?select=id,target_id,target_email_masked,target_role,requester_email_masked,reason_code,reason,status,created_at&school_id=eq."
      + encodeURIComponent(schoolId) + "&status=in.(pending,processing)&order=created_at.asc&limit=50",
    ),
    adminRequest(
      "account_suspensions?select=id,target_id,target_role,duration_hours,reason,expires_at,created_at&school_id=eq."
      + encodeURIComponent(schoolId) + "&status=eq.active&expires_at=gt."
      + encodeURIComponent(new Date().toISOString()) + "&order=expires_at.asc&limit=100",
    ),
  ]);

  if (!users.ok || !listings.ok || !audit.ok || !deletionRequests.ok || !suspensions.ok) {
    console.error("council_overview_failed", users.status, listings.status, audit.status, deletionRequests.status, suspensions.status);
    throw new Error("Не удалось загрузить панель управления.");
  }

  return {
    users: (users.data ?? []).map((row: any) => ({
      id: row.id,
      email: maskEmail(row.email),
      role: row.role,
      first_name: typeof row.first_name === "string" ? row.first_name : null,
      last_name: typeof row.last_name === "string" ? row.last_name : null,
      class_name: typeof row.class_name === "string" ? row.class_name : null,
      created_at: row.created_at,
    })),
    listings: (listings.data ?? []).map((row: any) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      price_text: row.price_text,
      category: row.category,
      city: row.city,
      user_id: row.user_id,
      status: row.status,
      moderation_status: row.moderation_status,
      is_event: row.is_event === true,
      event_date: row.event_date,
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
    deletion_requests: (deletionRequests.data ?? []).map((row: any) => ({
      id: row.id,
      target_id: row.target_id,
      target_email: row.target_email_masked || "Аккаунт",
      target_role: row.target_role,
      requester_email: row.requester_email_masked || "Участник совета",
      reason_code: row.reason_code,
      reason: row.reason,
      status: row.status,
      created_at: row.created_at,
    })),
    suspensions: (suspensions.data ?? []).map((row: any) => ({
      id: row.id,
      target_id: row.target_id,
      target_role: row.target_role,
      duration_hours: row.duration_hours,
      reason: row.reason,
      expires_at: row.expires_at,
      created_at: row.created_at,
    })),
  };
}

async function listSafetyReports(schoolId: string): Promise<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const retention = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Keep only recent, content-minimized safety metadata and sanitized excerpts.
  await adminRequest(
    "fam_safety_incidents?school_id=eq." + encodeURIComponent(schoolId)
    + "&created_at=lt." + encodeURIComponent(retention),
    "DELETE",
  );

  const result = await adminRequest(
    "fam_safety_incidents?select=pair_fingerprint,source_kind,category,severity,created_at,actor_id,target_id,source_origin,evidence_excerpt"
    + "&school_id=eq." + encodeURIComponent(schoolId)
    + "&created_at=gte." + encodeURIComponent(cutoff)
    + "&reviewed_at=is.null&order=created_at.desc&limit=400",
  );
  if (!result.ok || !Array.isArray(result.data)) {
    console.error("fam_safety_reports_list_failed", result.status);
    throw new Error("Не удалось загрузить отчёты безопасности.");
  }

  const groups = new Map<string, any>();
  for (const row of result.data) {
    if (typeof row?.pair_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.pair_fingerprint)) continue;
    const key = [row.pair_fingerprint, row.source_kind, row.category].join("|");
    const current = groups.get(key) ?? {
      fingerprint: row.pair_fingerprint,
      source_kind: row.source_kind,
      category: row.category,
      occurrences: 0,
      severity: "medium",
      first_seen: row.created_at,
      last_seen: row.created_at,
      actor_id: typeof row.actor_id === "string" ? row.actor_id : null,
      target_id: typeof row.target_id === "string" ? row.target_id : null,
      source_origin: typeof row.source_origin === "string" ? row.source_origin : null,
      evidence_excerpt: typeof row.evidence_excerpt === "string" ? row.evidence_excerpt : null,
    };
    current.occurrences += 1;
    if (row.severity === "high") current.severity = "high";
    if (typeof row.created_at === "string") {
      if (!current.first_seen || row.created_at < current.first_seen) current.first_seen = row.created_at;
      if (!current.last_seen || row.created_at > current.last_seen) current.last_seen = row.created_at;
    }
    if (current.occurrences >= 3) current.severity = "high";
    groups.set(key, current);
  }

  const grouped = Array.from(groups.values())
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, 50);

  // Resolve account identity only for the current administrator's school.
  // This endpoint is already restricted to school_admin and all IDs are filtered by school_id.
  const profileIds = Array.from(new Set(
    grouped.flatMap(row => [row.actor_id, row.target_id])
      .filter((id): id is string => typeof id === "string" && UUID_RE.test(id)),
  ));
  const profilesById = new Map<string, { id: string; email: string | null; role: string | null; first_name: string | null; last_name: string | null; class_name: string | null }>();
  for (let offset = 0; offset < profileIds.length; offset += 50) {
    const batch = profileIds.slice(offset, offset + 50);
    if (!batch.length) continue;
    const people = await adminRequest(
      "profiles?select=id,email,role,first_name,last_name,class_name&school_id=eq." + encodeURIComponent(schoolId)
      + "&id=in.(" + batch.map(id => encodeURIComponent(id)).join(",") + ")",
    );
    if (!people.ok || !Array.isArray(people.data)) {
      console.error("fam_safety_report_identity_lookup_failed", people.status);
      continue;
    }
    for (const profile of people.data) {
      if (typeof profile?.id === "string") {
        profilesById.set(profile.id, {
          id: profile.id,
          email: typeof profile.email === "string" ? profile.email : null,
          role: typeof profile.role === "string" ? profile.role : null,
          first_name: typeof profile.first_name === "string" ? profile.first_name : null,
          last_name: typeof profile.last_name === "string" ? profile.last_name : null,
          class_name: typeof profile.class_name === "string" ? profile.class_name : null,
        });
      }
    }
  }

  const reports = grouped.map(row => {
    const actor = row.actor_id ? profilesById.get(row.actor_id) ?? null : null;
    const target = row.target_id ? profilesById.get(row.target_id) ?? null : null;
    return {
      fingerprint: row.fingerprint,
      source_kind: row.source_kind,
      category: row.category,
      occurrences: row.occurrences,
      severity: row.severity,
      repeated: row.occurrences >= 3,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      source_origin: row.source_origin,
      evidence_excerpt: row.evidence_excerpt,
      actor: actor ? {
        email: actor.email,
        role: actor.role,
        first_name: actor.first_name,
        last_name: actor.last_name,
        class_name: actor.class_name,
        account_code: actor.id.slice(-6).toUpperCase(),
      } : null,
      target: target ? {
        email: target.email,
        role: target.role,
        first_name: target.first_name,
        last_name: target.last_name,
        class_name: target.class_name,
        account_code: target.id.slice(-6).toUpperCase(),
      } : null,
      identity_available: !!actor,
      identity_was_recorded: !!row.actor_id,
    };
  });

  return { reports, period_days: 30 };
}
async function listCouncilTargets(actor: any, actorId: string): Promise<Record<string, unknown>> {
  const [targets, ownRequests] = await Promise.all([
    adminRequest(
      "profiles?select=id,email,role&school_id=eq." + encodeURIComponent(actor.school_id)
      + "&id=neq." + encodeURIComponent(actorId)
      + "&role=in.(student,council_member)&order=created_at.desc&limit=200",
    ),
    adminRequest(
      "account_deletion_requests?select=id,target_email_masked,target_role,reason_code,reason,status,created_at,reviewed_at,review_note&requester_id=eq."
      + encodeURIComponent(actorId) + "&school_id=eq." + encodeURIComponent(actor.school_id)
      + "&order=created_at.desc&limit=10",
    ),
  ]);
  if (!targets.ok || !ownRequests.ok) throw new Error("Не удалось загрузить список аккаунтов.");
  return {
    targets: (targets.data ?? []).map((row: any) => ({
      id: row.id,
      email: maskEmail(row.email),
      role: row.role,
    })),
    my_requests: ownRequests.data ?? [],
  };
}

function tokenWasIssuedRecently(authorization: string): boolean {
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const raw = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
    const claims = JSON.parse(atob(padded));
    const issuedAt = Number(claims?.iat);
    const ageSeconds = Date.now() / 1000 - issuedAt;
    return Number.isFinite(issuedAt) && ageSeconds >= 0 && ageSeconds <= 600;
  } catch {
    return false;
  }
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
    // Auth validates the bearer token; its signed iat is used only for the fresh
    // sign-in requirement on permanent self-deletion.
    const authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": PUBLISHABLE_KEY, "Authorization": authorization },
    });
    if (!authResponse.ok) return json({ ok: false, error: "Сессия недействительна. Войдите заново." }, 401, headers);
    const authUser = await authResponse.json().catch(() => null);
    const actorId = typeof authUser?.id === "string" ? authUser.id : "";
    if (!UUID_RE.test(actorId)) return json({ ok: false, error: "Не удалось подтвердить пользователя." }, 401, headers);

    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 12_288) return json({ ok: false, error: "Запрос слишком большой." }, 413, headers);
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: "Некорректный формат запроса." }, 400, headers); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ ok: false, error: "Некорректный запрос." }, 400, headers);

    const actor = await getSchoolProfile(actorId);
    if (!actor) return json({ ok: false, error: "Профиль пользователя не найден." }, 403, headers);
    const action = payload.action;

    if (action === "my_suspension_status") {
      const suspension = await getActiveSuspension(actorId);
      return json({
        ok: true,
        suspended: !!suspension,
        suspension: suspension ? {
          reason: suspension.reason,
          expires_at: suspension.expires_at,
          duration_hours: suspension.duration_hours,
        } : null,
      }, 200, headers);
    }

    // A temporary restriction blocks all write/management actions, but leaves
    // status visibility and self-deletion available to the account owner.
    if (action !== "delete_my_account") {
      const suspension = await getActiveSuspension(actorId);
      if (suspension) {
        return json({
          ok: false,
          suspended: true,
          suspended_until: suspension.expires_at,
          error: "Действия аккаунта временно ограничены до "
            + new Date(suspension.expires_at).toLocaleString("ru-RU")
            + ". Причина: " + String(suspension.reason || "").slice(0, 240),
        }, 403, headers);
      }
    }

    // Any signed-in user may permanently delete their own account.
    // Require a fresh password sign-in and an explicit confirmation phrase.
    if (action === "delete_my_account") {
      if (payload.confirmation !== DELETE_CONFIRMATION) {
        return json({ ok: false, error: "Подтвердите удаление точной фразой." }, 400, headers);
      }
      if (!tokenWasIssuedRecently(authorization)) {
        return json({ ok: false, error: "Для удаления войдите в аккаунт заново и повторите действие." }, 403, headers);
      }

      if (actor.role === "school_admin" && actor.school_id) {
        const otherAdmins = await adminRequest(
          "profiles?select=id&school_id=eq." + encodeURIComponent(actor.school_id)
          + "&role=eq.school_admin&id=neq." + encodeURIComponent(actorId) + "&limit=1",
        );
        if (!otherAdmins.ok) return json({ ok: false, error: "Не удалось проверить наличие другого администратора." }, 503, headers);
        if (!Array.isArray(otherAdmins.data) || otherAdmins.data.length === 0) {
          return json({
            ok: false,
            error: "Вы последний администратор школы. Сначала назначьте другого администратора, затем удалите свой аккаунт.",
          }, 409, headers);
        }
      }

      await deleteAccountCompletely(actorId);
      return json({ ok: true, deleted: true }, 200, headers);
    }

    // Council members may request removal of a different same-school student/member.
    // Requests are never executed automatically; only a same-school admin can decide.
    if (action === "list_request_targets" || action === "request_account_deletion") {
      if (actor.role !== "council_member" || !actor.school_id) {
        return json({ ok: false, error: "Отправлять такие запросы могут только участники совета." }, 403, headers);
      }

      if (action === "list_request_targets") {
        return json({ ok: true, ...(await listCouncilTargets(actor, actorId)) }, 200, headers);
      }

      const targetId = typeof payload.target_id === "string" ? payload.target_id : "";
      const reasonCode = typeof payload.reason_code === "string" ? payload.reason_code : "";
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      const reasonDigits = reason.replace(/\D/g, "");
      const containsContact = /(?:https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(reason)
        || reasonDigits.length >= 11;
      if (containsContact) {
        return json({ ok: false, error: "Не указывайте телефоны, электронную почту, ссылки и другие личные контакты. Опишите только факты." }, 400, headers);
      }
      if (!UUID_RE.test(targetId) || targetId === actorId) {
        return json({ ok: false, error: "Выберите другой аккаунт." }, 400, headers);
      }
      if (!REASON_CODES.has(reasonCode)) return json({ ok: false, error: "Выберите причину обращения." }, 400, headers);
      if (reason.length < 15 || reason.length > 500) {
        return json({ ok: false, error: "Пояснение должно содержать от 15 до 500 символов." }, 400, headers);
      }

      const target = await getSchoolProfile(targetId);
      if (!target || target.school_id !== actor.school_id || !["student", "council_member"].includes(target.role)) {
        return json({ ok: false, error: "Можно отправлять запросы только по обычным аккаунтам своей школы и участникам совета." }, 403, headers);
      }

      const existing = await adminRequest(
        "account_deletion_requests?select=id,status,target_email_masked,created_at&school_id=eq."
        + encodeURIComponent(actor.school_id) + "&target_id=eq." + encodeURIComponent(targetId)
        + "&status=in.(pending,processing)&limit=1",
      );
      if (!existing.ok) return json({ ok: false, error: "Не удалось проверить предыдущие обращения." }, 503, headers);
      if (Array.isArray(existing.data) && existing.data[0]) {
        return json({ ok: true, already_exists: true, request: existing.data[0] }, 200, headers);
      }

      const insert = await adminRequest("account_deletion_requests?select=id,status,created_at", "POST", {
        school_id: actor.school_id,
        requester_id: actorId,
        target_id: targetId,
        requester_email_masked: maskEmail(actor.email || authUser.email),
        target_email_masked: maskEmail(target.email),
        target_role: target.role,
        reason_code: reasonCode,
        reason,
        status: "pending",
      });
      if (!insert.ok) {
        if (insert.status === 409 || insert.status === 400) {
          return json({ ok: false, error: "По этому аккаунту уже есть открытое обращение." }, 409, headers);
        }
        console.error("account_deletion_request_insert_failed", insert.status);
        return json({ ok: false, error: "Не удалось отправить обращение. Попробуйте позже." }, 503, headers);
      }
      const created = Array.isArray(insert.data) ? insert.data[0] ?? null : null;
      return json({ ok: true, request: created }, 200, headers);
    }

    // All remaining management actions are administrator-only.
    if (actor.role !== "school_admin" || !actor.school_id) {
      return json({ ok: false, error: "Эта операция доступна только администратору своей школы." }, 403, headers);
    }

    const sensitiveActions = new Set([
      "review_account_deletion",
      "delete_account",
      "revoke_role",
      "suspend_account",
      "lift_suspension",
    ]);
    if (sensitiveActions.has(action) && !tokenWasIssuedRecently(authorization)) {
      return json({
        ok: false,
        error: "Для этого действия нужно повторно подтвердить вход. Введите пароль администратора и повторите операцию.",
      }, 403, headers);
    }

    if (action === "overview") {
      return json({ ok: true, ...(await listOverview(actor.school_id)) }, 200, headers);
    }

    if (action === "agent_dashboard") {
      const dashboard = await adminRequest("rpc/get_fam_agent_admin_dashboard", "POST", {
        p_school_id: actor.school_id,
      });
      if (!dashboard.ok || !dashboard.data || dashboard.data.ok !== true) {
        console.error("fam_agent_dashboard_load_failed", dashboard.status);
        return json({ ok: false, error: "Не удалось загрузить отчёты и предложения команды FAM." }, 503, headers);
      }
      return json({
        ok: true,
        report: dashboard.data.report ?? null,
        agent_ideas: Array.isArray(dashboard.data.agent_ideas) ? dashboard.data.agent_ideas : [],
      }, 200, headers);
    }

    if (action === "review_agent_idea") {
      const ideaId = typeof payload.target_id === "string" ? payload.target_id : "";
      const decision = payload.decision === "approve" ? "approved"
        : payload.decision === "reject" ? "rejected" : "";
      if (!UUID_RE.test(ideaId) || !decision) {
        return json({ ok: false, error: "Выберите предложение и решение." }, 400, headers);
      }

      const reviewed = await adminRequest("rpc/review_fam_agent_idea", "POST", {
        p_idea_id: ideaId,
        p_reviewer_id: actorId,
        p_decision: decision,
      });
      if (!reviewed.ok) {
        console.error("fam_agent_idea_review_failed", reviewed.status);
        return json({ ok: false, error: "Не удалось сохранить решение по предложению." }, 503, headers);
      }
      if (reviewed.data?.ok !== true) {
        return json({ ok: false, error: "Это предложение уже рассмотрено или больше недоступно." }, 409, headers);
      }

      await recordAudit(actor.school_id, actorId, null, "fam_agent_idea_" + decision, {
        idea_id: ideaId,
      });
      return json({ ok: true, status: decision }, 200, headers);
    }


    if (action === "suspend_account") {
      const targetId = typeof payload.target_id === "string" ? payload.target_id : "";
      const durationHours = Number(payload.duration_hours);
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      const digitCount = (reason.match(/[0-9]/g) || []).length;
      const containsContact = reason.includes("http://")
        || reason.includes("https://")
        || /www[.]/i.test(reason)
        || /[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}/i.test(reason)
        || digitCount >= 11;
      if (!UUID_RE.test(targetId) || targetId === actorId) {
        return json({ ok: false, error: "Нельзя ограничить собственный аккаунт." }, 400, headers);
      }
      if (![24, 72, 168].includes(durationHours)) {
        return json({ ok: false, error: "Выберите срок 24 часа, 3 дня или 7 дней." }, 400, headers);
      }
      if (reason.length < 15 || reason.length > 400 || containsContact) {
        return json({ ok: false, error: "Укажите нейтральную причину длиной 15–400 символов, без контактов и личных данных." }, 400, headers);
      }

      const target = await getSchoolProfile(targetId);
      if (!target || target.school_id !== actor.school_id
          || !["student", "council_member"].includes(target.role)) {
        return json({ ok: false, error: "Ограничивать можно только обычные аккаунты и участников совета своей школы." }, 403, headers);
      }

      const previous = await adminRequest(
        "account_suspensions?select=id,expires_at,status&school_id=eq."
        + encodeURIComponent(actor.school_id) + "&target_id=eq." + encodeURIComponent(targetId)
        + "&status=eq.active&order=created_at.desc&limit=1",
      );
      if (!previous.ok) return json({ ok: false, error: "Не удалось проверить действующее ограничение." }, 503, headers);
      if (Array.isArray(previous.data) && previous.data[0]) {
        const old = previous.data[0];
        if (typeof old.expires_at === "string" && new Date(old.expires_at).getTime() > Date.now()) {
          return json({ ok: false, error: "У аккаунта уже есть действующее ограничение." }, 409, headers);
        }
        await adminRequest(
          "account_suspensions?id=eq." + encodeURIComponent(old.id) + "&status=eq.active",
          "PATCH",
          {
            status: "expired",
            lifted_at: old.expires_at || new Date().toISOString(),
            lift_reason: "Срок ограничения истёк",
          },
        );
      }

      const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
      const inserted = await adminRequest("account_suspensions?select=id,target_id,duration_hours,reason,expires_at,status", "POST", {
        school_id: actor.school_id,
        target_id: targetId,
        issued_by: actorId,
        target_role: target.role,
        duration_hours: durationHours,
        reason,
        status: "active",
        expires_at: expiresAt,
      });
      if (!inserted.ok || !Array.isArray(inserted.data) || !inserted.data[0]) {
        console.error("account_suspension_create_failed", inserted.status);
        return json({ ok: false, error: "Не удалось установить временное ограничение." }, 503, headers);
      }
      const row = inserted.data[0];
      await recordAudit(actor.school_id, actorId, targetId, "account_suspended", {
        suspension_id: row.id,
        duration_hours: durationHours,
        expires_at: row.expires_at,
        reason,
      });
      return json({ ok: true, suspension: row }, 200, headers);
    }

    if (action === "lift_suspension") {
      const targetId = typeof payload.target_id === "string" ? payload.target_id : "";
      if (!UUID_RE.test(targetId) || targetId === actorId) {
        return json({ ok: false, error: "Некорректный аккаунт." }, 400, headers);
      }
      const target = await getSchoolProfile(targetId);
      if (!target || target.school_id !== actor.school_id
          || !["student", "council_member"].includes(target.role)) {
        return json({ ok: false, error: "Аккаунт не найден среди пользователей вашей школы." }, 404, headers);
      }
      const active = await adminRequest(
        "account_suspensions?select=id,expires_at&school_id=eq."
        + encodeURIComponent(actor.school_id) + "&target_id=eq." + encodeURIComponent(targetId)
        + "&status=eq.active&expires_at=gt." + encodeURIComponent(new Date().toISOString())
        + "&order=created_at.desc&limit=1",
      );
      const row = active.ok && Array.isArray(active.data) ? active.data[0] ?? null : null;
      if (!row) return json({ ok: false, error: "Действующего ограничения нет." }, 404, headers);

      const lifted = await adminRequest(
        "account_suspensions?id=eq." + encodeURIComponent(row.id)
        + "&school_id=eq." + encodeURIComponent(actor.school_id) + "&status=eq.active",
        "PATCH",
        { status: "lifted", lifted_at: new Date().toISOString(), lifted_by: actorId, lift_reason: "Снято администратором" },
      );
      if (!lifted.ok || !Array.isArray(lifted.data) || lifted.data.length !== 1) {
        return json({ ok: false, error: "Не удалось снять ограничение. Обновите список." }, 409, headers);
      }
      await recordAudit(actor.school_id, actorId, targetId, "account_suspension_lifted", {
        suspension_id: row.id,
      });
      return json({ ok: true }, 200, headers);
    }

    if (action === "list_safety_reports") {
      return json({ ok: true, ...(await listSafetyReports(actor.school_id)) }, 200, headers);
    }

    if (action === "acknowledge_safety_report") {
      const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint : "";
      const category = typeof payload.category === "string" ? payload.category : "";
      const sourceKind = typeof payload.source_kind === "string" ? payload.source_kind : "";
      const allowedCategories = new Set([
        "targeted_harassment",
        "hate_or_discrimination",
        "threat_or_intimidation",
        "negative_personal_call",
        "spam_or_repeated_abuse",
        "unsafe_image",
        "personal_data_in_image",
        "unclear_safety_signal",
      ]);
      if (!/^[0-9a-f]{64}$/.test(fingerprint) || !allowedCategories.has(category)
          || !["message", "idea", "listing", "image"].includes(sourceKind)) {
        return json({ ok: false, error: "Некорректный номер отчёта." }, 400, headers);
      }

      const reviewed = await adminRequest(
        "fam_safety_incidents?school_id=eq." + encodeURIComponent(actor.school_id)
        + "&pair_fingerprint=eq." + encodeURIComponent(fingerprint)
        + "&category=eq." + encodeURIComponent(category)
        + "&source_kind=eq." + encodeURIComponent(sourceKind)
        + "&reviewed_at=is.null",
        "PATCH",
        { reviewed_at: new Date().toISOString(), reviewed_by: actorId },
      );
      if (!reviewed.ok) {
        console.error("fam_safety_report_ack_failed", reviewed.status);
        return json({ ok: false, error: "Не удалось отметить отчёт как рассмотренный." }, 503, headers);
      }
      return json({ ok: true }, 200, headers);
    }

    if (action === "review_account_deletion") {
      const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
      const decision = payload.decision;
      const reviewNote = typeof payload.review_note === "string" ? payload.review_note.trim().slice(0, 240) : "";
      if (!UUID_RE.test(requestId) || !["approve", "reject"].includes(decision)) {
        return json({ ok: false, error: "Некорректное решение по обращению." }, 400, headers);
      }

      const found = await adminRequest(
        "account_deletion_requests?select=id,school_id,requester_id,target_id,target_email_masked,target_role,status,reason_code,reason&id=eq."
        + encodeURIComponent(requestId) + "&school_id=eq." + encodeURIComponent(actor.school_id) + "&limit=1",
      );
      const request = found.ok && Array.isArray(found.data) ? found.data[0] ?? null : null;
      if (!request) return json({ ok: false, error: "Обращение не найдено в вашей школе." }, 404, headers);
      if (request.status !== "pending") return json({ ok: false, error: "Обращение уже рассматривается или закрыто." }, 409, headers);

      if (decision === "reject") {
        const rejected = await adminRequest(
          "account_deletion_requests?id=eq." + encodeURIComponent(requestId)
          + "&school_id=eq." + encodeURIComponent(actor.school_id) + "&status=eq.pending",
          "PATCH",
          { status: "rejected", reviewer_id: actorId, reviewed_at: new Date().toISOString(), review_note: reviewNote || null },
        );
        if (!rejected.ok || !Array.isArray(rejected.data) || rejected.data.length !== 1) {
          return json({ ok: false, error: "Обращение уже обработано другим администратором." }, 409, headers);
        }
        await recordAudit(actor.school_id, actorId, request.target_id, "account_deletion_request_rejected", {
          request_id: requestId,
          reason_code: request.reason_code,
        });
        return json({ ok: true, status: "rejected" }, 200, headers);
      }

      const claimed = await adminRequest(
        "account_deletion_requests?id=eq." + encodeURIComponent(requestId)
        + "&school_id=eq." + encodeURIComponent(actor.school_id) + "&status=eq.pending",
        "PATCH",
        { status: "processing", reviewer_id: actorId, reviewed_at: new Date().toISOString() },
      );
      if (!claimed.ok || !Array.isArray(claimed.data) || claimed.data.length !== 1) {
        return json({ ok: false, error: "Обращение уже взял в работу другой администратор." }, 409, headers);
      }

      try {
        if (!request.target_id) throw new Error("Аккаунт уже недоступен.");
        const target = await getSchoolProfile(request.target_id);
        if (!target || target.school_id !== actor.school_id || !["student", "council_member"].includes(target.role)) {
          throw new Error("Аккаунт больше не подходит под условия удаления.");
        }
        await deleteAccountCompletely(request.target_id, requestId);

        const completed = await adminRequest(
          "account_deletion_requests?id=eq." + encodeURIComponent(requestId)
          + "&school_id=eq." + encodeURIComponent(actor.school_id) + "&status=eq.processing",
          "PATCH",
          { status: "approved", reviewer_id: actorId, reviewed_at: new Date().toISOString(), review_note: reviewNote || null },
        );
        if (!completed.ok || !Array.isArray(completed.data) || completed.data.length !== 1) {
          console.error("account_deletion_request_completion_update_failed", completed.status);
        }
        try {
          await recordAudit(actor.school_id, actorId, null, "account_deleted_by_request", {
            request_id: requestId,
            target_role: request.target_role,
          });
        } catch (auditError) {
          console.error("account_deletion_audit_failed_after_delete", auditError instanceof Error ? auditError.name : "unknown");
        }
        return json({ ok: true, status: "approved" }, 200, headers);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось удалить аккаунт.";
        await adminRequest(
          "account_deletion_requests?id=eq." + encodeURIComponent(requestId)
          + "&school_id=eq." + encodeURIComponent(actor.school_id) + "&status=eq.processing",
          "PATCH",
          { status: "pending", reviewer_id: null, reviewed_at: null, review_note: message.slice(0, 240) },
        );
        return json({ ok: false, error: message }, 503, headers);
      }
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
      // Owners may remove their own listings with the current authenticated session.
      // Deleting another member's listing still requires a recent password sign-in.
      if (listing.user_id !== actorId && !tokenWasIssuedRecently(authorization)) {
        return json({
          ok: false,
          error: "Для удаления чужого объявления администратору нужно повторно подтвердить вход.",
        }, 403, headers);
      }

      const removed = await adminRequest(
        "listings?id=eq." + encodeURIComponent(targetId),
        "DELETE",
      );
      if (!removed.ok) return json({ ok: false, error: "Не удалось удалить объявление." }, 503, headers);

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

      await recordAudit(actor.school_id, actorId, null, "listing_deleted", {
        listing_id: targetId,
        category: String(listing.category ?? "").slice(0, 40),
        image_cleanup: imageCleanup,
      });
      return json({ ok: true, image_cleanup: imageCleanup }, 200, headers);
    }

    if (action === "delete_account") {
      if (targetId === actorId) return json({ ok: false, error: "Для своего аккаунта используйте раздел «Удалить мой аккаунт»." }, 403, headers);
      const target = await getSchoolProfile(targetId);
      if (!target || target.school_id !== actor.school_id) {
        return json({ ok: false, error: "Аккаунт не найден в вашей школе." }, 404, headers);
      }
      if (!["student", "council_member"].includes(target.role)) {
        return json({ ok: false, error: "Удалять можно только аккаунты учеников и участников совета. Аккаунт администратора сначала должен передать полномочия." }, 403, headers);
      }

      await deleteAccountCompletely(targetId);
      try {
        await recordAudit(actor.school_id, actorId, null, "account_deleted_by_admin", {
          target_role: target.role,
          source: "admin_panel",
        });
      } catch (auditError) {
        console.error("admin_account_deletion_audit_failed", auditError instanceof Error ? auditError.name : "unknown");
      }
      return json({ ok: true }, 200, headers);
    }

    return json({ ok: false, error: "Неизвестное действие." }, 400, headers);
  } catch (error) {
    console.error("council_management_failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false, error: error instanceof Error ? error.message : "Внутренняя ошибка. Попробуйте позже." }, 500, headers);
  }
});
