/**
 * A queue task may skip image AI review only when the current database profile
 * is still one of the two trusted school roles and both records point to the
 * same non-empty school. Callers must load profile from Supabase server-side.
 */
export function canSkipTrustedSchoolPhotoReview(profile, task) {
  const profileSchool = typeof profile?.school_id === "string" ? profile.school_id.trim() : "";
  const taskSchool = typeof task?.school_id === "string" ? task.school_id.trim() : "";
  return Boolean(
    profileSchool
      && taskSchool
      && profileSchool === taskSchool
      && (profile?.role === "school_admin" || profile?.role === "council_member")
  );
}
