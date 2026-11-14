import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbListingsRepository } from '../repositories/ydb-listings.mjs';

test('school listing deletion fake query adapter covers standalone context lookup and transactional deletes', async () => {
  const calls = [];
  let schoolId = 'school-a';
  const execute = async (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('SELECT school_id, role, active FROM fam_user_profiles')) return [[{ school_id: 'school-a', role: 'school_admin', active: true }]];
    if (text.includes('SELECT user_id, school_id, category FROM fam_listings')) {
      return schoolId === 'school-a' ? [[{ user_id: 'student-a', school_id: schoolId, category: 'Книги' }]] : [[]];
    }
    if (text.includes('SELECT id, user_id, school_id, category, is_event, image_key FROM fam_listings')) {
      return [[{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: 'student-a', school_id: schoolId, category: 'Книги',
        is_event: true, image_key: 'pending/student-a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp' }]];
    }
    if (text.includes('SELECT user_id FROM fam_pending_media')) return [[{ user_id: 'student-a' }]];
    if (text.includes('SELECT object_key, claim_token FROM fam_pending_media')) {
      return [[{ object_key: 'pending/student-a/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', claim_token: values.at(-1) }]];
    }
    return [[]];
  };
  const sql = Object.assign(execute, { begin: callback => callback(execute) });
  const repo = createYdbListingsRepository(sql);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.deepEqual(await repo.getSchoolListingDeletionContext({ schoolId: 'school-a', actorId: 'admin-a', listingId: id }),
    { user_id: 'student-a', school_id: 'school-a', category: 'Книги' });
  const result = await repo.deleteSchoolListing({ schoolId: 'school-a', actorId: 'admin-a', listingId: id });
  assert.equal(result.ok, true);
  assert.ok(result.media_cleanup);
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_event_registrations')));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_event_occupancy')));
  assert.ok(calls.some(call => call.text.includes('DELETE FROM fam_favorites')));
  assert.ok(calls.some(call => call.text.includes("SET status = 'deleting'")));
  assert.ok(calls.some(call => call.text.includes('INSERT INTO fam_school_content_audit')));
  schoolId = 'school-b';
  assert.equal(await repo.getSchoolListingDeletionContext({ schoolId: 'school-a', actorId: 'admin-a', listingId: id }), null);
  assert.deepEqual(await repo.deleteSchoolListing({ schoolId: 'school-a', actorId: 'admin-a', listingId: id }),
    { ok: false, code: 'listing_unavailable' });
});
