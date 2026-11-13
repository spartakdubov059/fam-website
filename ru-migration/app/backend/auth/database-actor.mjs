export function createDatabaseActorResolver(sql) {
  if (typeof sql !== 'function') throw new TypeError('database query client is required');
  return async function resolveActor(identity) {
    if (!identity?.issuer || !identity?.subject) return null;
    const sets = await sql`SELECT user_id, school_id, role, active
      FROM fam_user_profiles WHERE issuer = ${identity.issuer} AND subject = ${identity.subject} LIMIT 1;`;
    const profile = sets?.[0]?.[0];
    if (!profile || profile.active !== true || !profile.user_id || !profile.school_id) return null;
    return Object.freeze({ id: profile.user_id, school_id: profile.school_id, role: profile.role });
  };
}
