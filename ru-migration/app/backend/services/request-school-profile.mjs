import { getSchool, isSchoolClassName } from '../policies/school-catalog.mjs';

export async function requestSchoolProfile({ identity, input, repository }) {
  if (!identity || typeof identity.issuer !== 'string' || typeof identity.subject !== 'string'
      || !identity.issuer || !identity.subject) return { ok: false, code: 'unauthenticated' };
  const school = getSchool(input?.school_id);
  const firstName = typeof input?.first_name === 'string' ? input.first_name.trim() : '';
  const lastName = typeof input?.last_name === 'string' ? input.last_name.trim() : '';
  const personType = input?.person_type ?? 'student';
  const staffPosition = typeof input?.staff_position === 'string' ? input.staff_position.trim() : '';
  const className = typeof input?.class_name === 'string' ? input.class_name.trim().toUpperCase().replace(/\s+/gu, '') : '';
  if (!school || firstName.length < 1 || firstName.length > 60 || lastName.length < 1 || lastName.length > 60
      || !['student', 'school_staff', 'parent'].includes(personType)
      || (personType === 'student' && !isSchoolClassName(className))
      || (personType !== 'student' && className !== '')
      || (personType === 'school_staff' && (staffPosition.length < 1 || staffPosition.length > 100))
      || (personType !== 'school_staff' && staffPosition !== '')
      || /[<>\u0000-\u001f]/u.test(firstName + lastName + staffPosition)) {
    return { ok: false, code: 'invalid_profile_request' };
  }
  if (typeof repository?.createSchoolProfileRequest !== 'function') return { ok: false, code: 'database_unavailable' };
  try {
    const result = await repository.createSchoolProfileRequest({
      issuer: identity.issuer, subject: identity.subject, school_id: school.id,
      first_name: firstName, last_name: lastName, class_name: className,
      person_type: personType, staff_position: staffPosition,
    });
    return result?.ok ? { ok: true, status: result.status, request_id: result.request_id } : { ok: false, code: result?.code || 'database_unavailable' };
  } catch { return { ok: false, code: 'database_unavailable' }; }
}
