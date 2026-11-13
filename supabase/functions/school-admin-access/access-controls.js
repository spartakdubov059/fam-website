const ALLOWED_COUNCIL_ROLES = new Set([
  "Участник Ученического совета",
  "Администратор",
  // Legacy label is accepted for the existing pending application only.
  "Член Ученического совета",
]);

function displayApplicantRole(value) {
  if (value === "Администратор") return "Администратор";
  if (value === "Участник Ученического совета" || value === "Член Ученического совета") {
    return "Участник Ученического совета";
  }
  return typeof value === "string" ? value : "";
}

export function isAllowedApplicantNote(value) {
  return typeof value === "string" && ALLOWED_COUNCIL_ROLES.has(value.trim());
}

export function maskApplicantEmail(value) {
  if (typeof value !== "string") return "Пользователь";
  const email = value.trim();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "Пользователь";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain || /[\s<>]/u.test(domain)) return "Пользователь";
  return local.slice(0, 1) + "***@" + domain;
}

export function mapSchoolAdminRequests(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    id: typeof row?.request_id === "string"
      ? row.request_id
      : (typeof row?.id === "string" ? row.id : ""),
    user_id: typeof row?.user_id === "string" ? row.user_id.slice(-6).toUpperCase() : "",
    applicant_first_name: typeof row?.applicant_first_name === "string" ? row.applicant_first_name : null,
    applicant_last_name: typeof row?.applicant_last_name === "string" ? row.applicant_last_name : null,
    applicant_class: typeof row?.applicant_class === "string" ? row.applicant_class : null,
    applicant_note: displayApplicantRole(row?.applicant_note),
    status: typeof row?.status === "string" ? row.status : "pending",
    created_at: row?.created_at ?? null,
    review_started_at: row?.review_started_at ?? null,
    review_started_by: typeof row?.review_started_by === "string" ? row.review_started_by : null,
  })).filter((row) => row.id.length > 0);
}
