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
      // Query is both thenable and EventEmitter; errors still propagate via await.
      if (typeof statement?.on === 'function') statement.on('error', () => {});
      await statement;
      return { id };
    },
  };
}
