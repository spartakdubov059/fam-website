import { randomUUID } from 'node:crypto';

// The caller owns the connection and injects a @ydbjs/query tagged client.
// Dynamic values are bound by the SDK, never concatenated into YQL.
export function createYdbListingsRepository(sql) {
  if (typeof sql !== 'function') throw new TypeError('YDB query client is required');
  return {
    async createListing(record) {
      if (!record || record.status !== 'pending' || !record.user_id || !record.school_id) throw new TypeError('invalid pending listing');
      if (!Number.isInteger(record.max_seats) || record.max_seats < 0 || record.max_seats > 500) throw new TypeError('invalid max_seats');
      const id = randomUUID();
      const statement = sql`INSERT INTO fam_listings
        (id, user_id, school_id, title, description, category, price_text, is_event,
         event_date, event_time, event_type, max_seats, status, created_at)
        VALUES (${id}, ${record.user_id}, ${record.school_id}, ${record.title}, ${record.description},
          ${record.category}, ${record.price_text}, ${record.is_event}, ${record.event_date ?? ''},
          ${record.event_time ?? ''}, ${record.event_type ?? ''}, Unwrap(CAST(${record.max_seats} AS Uint32)),
          ${record.status}, CurrentUtcTimestamp());`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      await statement;
      return { id };
    },

    async createIdea(record) {
      if (!record || !record.user_id || !record.school_id || typeof record.text !== 'string'
          || !['pending', 'approved'].includes(record.ai_status) || record.admin_status !== 'new') {
        throw new TypeError('invalid idea submission');
      }
      const id = randomUUID();
      const statement = sql`INSERT INTO fam_ideas
        (id, user_id, school_id, text, ai_status, ai_summary, ai_reason, admin_status, created_at)
        VALUES (${id}, ${record.user_id}, ${record.school_id}, ${record.text}, ${record.ai_status},
          ${record.ai_summary ?? ''}, ${record.ai_reason ?? ''}, ${record.admin_status}, CurrentUtcTimestamp());`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      await statement;
      return { id };
    },

    async createMessage(record) {
      if (!record || !record.sender_id || !record.receiver_id || !record.school_id
          || typeof record.body !== 'string' || !record.body.trim() || record.body.length > 1000
          || record.sender_id === record.receiver_id) throw new TypeError('invalid message');
      const recipient = sql`SELECT user_id AS user_id FROM fam_user_profiles
        WHERE user_id = ${record.receiver_id} AND school_id = ${record.school_id} AND active = true LIMIT 1;`;
      if (typeof recipient?.on === 'function') recipient.on('error', () => {});
      const recipients = await recipient;
      if (!(recipients?.[0] ?? []).length) {
        const error = new Error('recipient unavailable');
        error.code = 'recipient_unavailable';
        throw error;
      }
      const id = randomUUID();
      const statement = sql`INSERT INTO fam_messages (id, sender_id, receiver_id, school_id, body, is_read, created_at)
        VALUES (${id}, ${record.sender_id}, ${record.receiver_id}, ${record.school_id}, ${record.body}, false, CurrentUtcTimestamp());`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      await statement;
      return { id };
    },

    async listMessages(userId, schoolId) {
      if (!userId || !schoolId) throw new TypeError('invalid message owner');
      const statement = sql`SELECT id, sender_id, receiver_id, body, is_read, created_at FROM fam_messages
        WHERE school_id = ${schoolId} AND (sender_id = ${userId} OR receiver_id = ${userId})
        ORDER BY created_at DESC LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const sets = await statement;
      return sets?.[0] ?? [];
    },

    async markMessageRead(userId, schoolId, messageId) {
      if (!userId || !schoolId || !messageId) throw new TypeError('invalid message owner');
      const owned = sql`SELECT id FROM fam_messages WHERE id = ${messageId}
        AND receiver_id = ${userId} AND school_id = ${schoolId} LIMIT 1;`;
      if (typeof owned?.on === 'function') owned.on('error', () => {});
      if (!(await owned)?.[0]?.length) return false;
      const update = sql`UPDATE fam_messages SET is_read = true WHERE id = ${messageId};`;
      if (typeof update?.on === 'function') update.on('error', () => {});
      await update;
      return true;
    },

    async listFavoriteIds(userId) {
      if (typeof userId !== 'string' || !userId) throw new TypeError('invalid user id');
      const statement = sql`SELECT f.listing_id AS listing_id FROM fam_favorites AS f
        INNER JOIN fam_listings AS l ON f.listing_id = l.id
        WHERE f.user_id = ${userId} AND l.status = 'active';`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const resultSets = await statement;
      return (resultSets?.[0] ?? []).map(row => row.listing_id);
    },

    async setFavorite(userId, listingId, favorite) {
      if (typeof userId !== 'string' || !userId || typeof listingId !== 'string' || !listingId || typeof favorite !== 'boolean') {
        throw new TypeError('invalid favorite request');
      }
      if (favorite) {
        const active = sql`SELECT id FROM fam_listings WHERE id = ${listingId} AND status = 'active' LIMIT 1;`;
        if (typeof active?.on === 'function') active.on('error', () => {});
        const rows = await active;
        if (!(rows?.[0] ?? []).length) return false;
        const insert = sql`UPSERT INTO fam_favorites (user_id, listing_id, created_at)
          VALUES (${userId}, ${listingId}, CurrentUtcTimestamp());`;
        if (typeof insert?.on === 'function') insert.on('error', () => {});
        await insert;
        return true;
      }
      const remove = sql`DELETE FROM fam_favorites WHERE user_id = ${userId} AND listing_id = ${listingId};`;
      if (typeof remove?.on === 'function') remove.on('error', () => {});
      await remove;
      return true;
    },

    async listActiveListings() {
      const statement = sql`SELECT id, title, description, category, price_text, is_event,
        event_date, event_time, event_type, max_seats, created_at
        FROM fam_listings
        WHERE status = 'active'
        ORDER BY created_at DESC
        LIMIT 100;`;
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      const resultSets = await statement;
      return (resultSets?.[0] ?? []).map(row => ({
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        price_text: row.price_text,
        is_event: row.is_event,
        event_date: row.event_date || null,
        event_time: row.event_time || null,
        event_type: row.event_type || null,
        max_seats: row.max_seats,
        created_at: row.created_at,
      }));
    },
  };
}
