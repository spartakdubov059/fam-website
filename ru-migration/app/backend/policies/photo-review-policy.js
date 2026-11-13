/**
 * Server-side exception for image AI review on trusted FAM school roles.
 * The caller must pass a profile loaded from the database after authenticating
 * the request; never pass client-submitted role or user_metadata here.
 */
export function canSkipListingImageReview(profile, imageUrl) {
  return Boolean(
    imageUrl
      && profile
      && typeof profile.school_id === "string"
      && profile.school_id.trim().length > 0
      && (profile.role === "school_admin" || profile.role === "council_member")
  );
}
