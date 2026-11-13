export function createDatabaseActorResolver(sql) {
  if (typeof sql !== 'function') throw new TypeError('database query client is required');
  return async function resolveActor(identity) {
    if (!identity?.issuer || !identity?.subject) return null;
    const sets = await sql`SELECT user_id, school_id, role, active, first_name, last_name, class_name, city, avatar_url
      FROM fam_user_profiles WHERE issuer = ${identity.issuer} AND subject = ${identity.subject} LIMIT 1;`;
    const profile = sets?.[0]?.[0];
    if (!profile || profile.active !== true || !profile.user_id || !profile.school_id) return null;
    return Object.freeze({
      id: profile.user_id, school_id: profile.school_id, role: profile.role,
      first_name: profile.first_name ?? null, last_name: profile.last_name ?? null,
      class_name: profile.class_name ?? null, city: profile.city ?? null,
      avatar_url: profile.avatar_url ?? null,
    });
  };
}
