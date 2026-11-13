import { getSchool } from '../policies/school-catalog.mjs';

const CLASS_NAME = /^[1-9][0-9]?[А-ЯЁA-Z]?$/u;

export async function requestSchoolProfile({ identity, input, repository }) {
  if (!identity || typeof identity.issuer !== 'string' || typeof identity.subject !== 'string'
      || !identity.issuer || !identity.subject) return { ok: false, code: 'unauthenticated' };
  const school = getSchool(input?.school_id);
  const firstName = typeof input?.first_name === 'string' ? input.first_name.trim() : '';
  const lastName = typeof input?.last_name === 'string' ? input.last_name.trim() : '';
  const className = typeof input?.class_name === 'string' ? input.class_name.trim().toUpperCase().replace(/\s+/gu, '') : '';
  if (!school || firstName.length < 1 || firstName.length > 80 || lastName.length < 1 || lastName.length > 80
      || !CLASS_NAME.test(className) || /[<>]/u.test(firstName + lastName)) {
    return { ok: false, code: 'invalid_profile_request' };
  }
  if (typeof repository?.createSchoolProfileRequest !== 'function') return { ok: false, code: 'database_unavailable' };
  try {
    const result = await repository.createSchoolProfileRequest({
      issuer: identity.issuer, subject: identity.subject, school_id: school.id,
      first_name: firstName, last_name: lastName, class_name: className,
    });
    return result?.ok ? { ok: true, status: result.status, request_id: result.request_id } : { ok: false, code: result?.code || 'database_unavailable' };
  } catch { return { ok: false, code: 'database_unavailable' }; }
}
