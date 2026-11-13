// This catalog mirrors the two school IDs recognized by the current FAM UI.
// Add schools only through reviewed source changes; applicants cannot create schools.
export const SCHOOL_CATALOG = Object.freeze([
  Object.freeze({ id: 'lyceum_3', name: 'Лицей № 3' }),
  Object.freeze({ id: 'gymnasium_4', name: 'Гимназия № 4' }),
]);

export function getSchool(schoolId) {
  return SCHOOL_CATALOG.find(school => school.id === schoolId) || null;
}
