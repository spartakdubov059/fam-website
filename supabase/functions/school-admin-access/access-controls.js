const ALLOWED_COUNCIL_ROLES = new Set([
  "Председатель Ученического совета",
  "Заместитель председателя Ученического совета",
  "Секретарь Ученического совета",
  "Член Ученического совета",
]);

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
    user_id: typeof row?.user_id === "string" ? row.user_id.slice(0, 8) : "",
    applicant_email: maskApplicantEmail(row?.applicant_email),
    applicant_note: typeof row?.applicant_note === "string" ? row.applicant_note : "",
    created_at: row?.created_at ?? null,
  })).filter((row) => row.id.length > 0);
}
