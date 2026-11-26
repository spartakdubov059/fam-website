import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticMigrationPlan, verifySyntheticMigrationPackage } from './synthetic-migration-runner.mjs';
import { createHash } from 'node:crypto';

test('synthetic migration runner rejects non-synthetic and mismatched snapshots', () => {
  assert.deepEqual(createSyntheticMigrationPlan({}),
    { ok: false, code: 'INVALID_MIGRATION_PLAN_INPUT', live_cutover_authorized: false });
  const input = {
    source: { snapshot_id: 'real-production' },
    target: { snapshot_id: 'real-production' },
    restored: { snapshot_id: 'real-production' },
    inventory: { snapshot_id: 'real-production' },
    objects: [],
    state: {},
    profiles: [], target_state: {}, target_profiles: [], restored_state: {}, restored_profiles: [],
  };
  assert.deepEqual(createSyntheticMigrationPlan(input),
    { ok: false, code: 'NON_SYNTHETIC_SNAPSHOT', live_cutover_authorized: false });
});

test('synthetic migration package verifier rejects untrusted inputs and digest mismatch', () => {
  assert.deepEqual(verifySyntheticMigrationPackage(null, '0'.repeat(64)),
    { ok: false, code: 'INVALID_MIGRATION_PACKAGE_INPUT', live_cutover_authorized: false });
  assert.deepEqual(verifySyntheticMigrationPackage(Buffer.from('{}'), '1'.repeat(64)),
    { ok: false, code: 'MIGRATION_PACKAGE_DIGEST_MISMATCH', live_cutover_authorized: false });
});

function fixture() {
  const a = 'synthetic-a';
  const b = 'synthetic-b';
  const school = 'synthetic-school';
  const listingId = 'synthetic-listing';
  const createdAt = '2026-11-24T12:00:00.000Z';
  const expiresAt = '2026-11-25T12:00:00.000Z';
  const accounts = [
    { user_id: a, school_id: school, role: 'student', active: true },
    { user_id: b, school_id: school, role: 'council_member', active: true },
  ];
  const content = {
    profiles: accounts.map(({ user_id, school_id }) => ({ user_id, school_id })),
    listings: [{ id: listingId, user_id: a, school_id: school, image_key: 'synthetic-photo' }],
    ideas: [{ id: 'synthetic-idea', user_id: b, school_id: school }],
    messages: [{ id: 'synthetic-message', sender_id: b, receiver_id: a, school_id: school, listing_id: listingId }],
    pending_messages: [{ id: 'synthetic-pending', sender_id: a, receiver_id: b, school_id: school, listing_id: listingId }],
    favorites: [{ user_id: b, listing_id: listingId }],
    media: [{ object_key: 'synthetic-photo', user_id: a }],
    idea_images: [],
  };
  const payloads = {
    listings: [{ id: listingId, title: 'synthetic:title', description: 'synthetic:description', created_at: createdAt }],
    ideas: [{ id: 'synthetic-idea', body: 'synthetic:idea', created_at: createdAt }],
    messages: [{ id: 'synthetic-message', body: 'synthetic:message', created_at: createdAt }],
    pending_messages: [{ id: 'synthetic-pending', body: 'synthetic:pending', created_at: createdAt }],
  };
  const activity = {
    listing_event_fields: [{ id: listingId, is_event: true, event_date: '2026-11-25', event_time: '10:00', event_type: 'limited', max_seats: 1 }],
    event_registrations: [{ event_id: listingId, user_id: b, school_id: school, status: 'confirmed', created_at: createdAt }],
    event_occupancy: [{ event_id: listingId, taken: 1 }],
    announcements: [{ announcement_id: 'synthetic-news', school_id: school, author_id: a, title: 'synthetic:news', body: 'synthetic:body', kind: 'news', event_starts_at: null, published_at: createdAt, expires_at: expiresAt }],
    polls: [{ poll_id: 'synthetic-poll', school_id: school, author_id: a, question: 'synthetic:question', options: ['synthetic:yes', 'synthetic:no'], created_at: createdAt, closes_at: expiresAt }],
    votes: [{ poll_id: 'synthetic-poll', voter_id: b, school_id: school, choice_index: 1, created_at: createdAt }],
  };
  const source = {
    snapshot_id: 'synthetic-batch',
    accounts,
    content,
    objects: [{ object_key: 'synthetic-photo', byte_length: 16, sha256: 'a'.repeat(64), user_id: a }],
    payloads,
    activity,
  };
  const target = structuredClone(source);
  target.accounts = accounts.map((row, index) => ({ ...row, issuer: 'https://synthetic.invalid', subject: `synthetic-identity-${index}` }));
  const restored = structuredClone(source);
  const inventory = {
    snapshot_id: source.snapshot_id,
    counts: {
      profiles: 2, listings: 1, ideas: 1, messages: 1, pending_messages: 1,
      favorites: 1, media: 1, idea_images: 0, event_registrations: 1,
      event_occupancy: 1, announcements: 1, polls: 1, votes: 1,
    },
  };
  const state = {
    listings: [{ id: listingId, category: 'Мероприятия', price_text: 'Бесплатно', status: 'active', photo_status: 'approved' }],
    ideas: [{ id: 'synthetic-idea', image_status: 'none', ai_status: 'pending', ai_summary: '', ai_reason: 'synthetic:review', admin_status: 'new' }],
    messages: [{ id: 'synthetic-message', is_read: true }],
    favorites: [{ user_id: b, listing_id: listingId, created_at: createdAt }],
    media: [{ object_key: 'synthetic-photo', status: 'linked', claim_token: '', created_at: createdAt, claim_until: createdAt }],
    idea_images: [],
  };
  const profiles = [
    { user_id: a, first_name: 'synthetic:First', last_name: 'synthetic:Last', class_name: '8Б', city: null, avatar_url: '', person_type: 'student', staff_position: null, staff_verification_status: 'not_required' },
    { user_id: b, first_name: 'synthetic:Council', last_name: 'synthetic:Member', class_name: '9А', city: null, avatar_url: '', person_type: 'student', staff_position: null, staff_verification_status: 'not_required' },
  ];
  const bytes = Buffer.from('synthetic:test-photo');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  source.objects[0].byte_length = bytes.length;
  source.objects[0].sha256 = sha256;
  target.objects[0].byte_length = bytes.length;
  target.objects[0].sha256 = sha256;
  restored.objects[0].byte_length = bytes.length;
  restored.objects[0].sha256 = sha256;

  return {source,target,restored,inventory,objects:[{object_key:'synthetic-photo',bytes}],state,profiles,target_state:structuredClone(state),target_profiles:structuredClone(profiles),restored_state:structuredClone(state),restored_profiles:structuredClone(profiles)};
}
test('synthetic migration runner creates a package with no live cutover authorization', () => {
  const prepared = createSyntheticMigrationPlan(fixture());
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.live_cutover_authorized, false);
  assert.match(prepared.plan_sha256, /^[a-f0-9]{64}$/);
  assert.equal(verifySyntheticMigrationPackage(prepared.archive, prepared.archiveSha256 ?? prepared.plan.archive_sha256).ok, true);
});

for (const [name,mutate,code,stage] of [
 ['changed target read status',x=>x.target_state.messages[0].is_read=false,'RECORD_STATE_MISMATCH','target_state'],
 ['changed restored moderation',x=>x.restored_state.ideas[0].ai_status='approved','RECORD_STATE_MISMATCH','restored_state'],
 ['changed target class',x=>x.target_profiles[0].class_name='9Б','PROFILE_DETAILS_MISMATCH','target_profiles'],
 ['changed restored name',x=>x.restored_profiles[0].first_name='synthetic:Different','PROFILE_DETAILS_MISMATCH','restored_profiles'],
 ['missing independent target state',x=>delete x.target_state,'INVALID_MIGRATION_PLAN_INPUT',undefined],
 ['missing independent restored profiles',x=>delete x.restored_profiles,'INVALID_MIGRATION_PLAN_INPUT',undefined],
 ['shared omission despite matching copies',x=>{for(const k of ['source','target','restored'])x[k].activity.votes=[];},'SOURCE_INVENTORY_COUNT_MISMATCH','source']
]) test(name,()=>{const x=fixture();mutate(x);const r=createSyntheticMigrationPlan(x);assert.equal(r.ok,false);assert.equal(r.code,code);assert.equal(r.stage,stage);assert.equal(r.live_cutover_authorized,false);assert.equal(Object.hasOwn(r,'archive'),false);});
test('inventory digest is order independent and plan binds archive digest',()=>{const x=fixture();const a=createSyntheticMigrationPlan(x);assert.equal(a.ok,true);x.inventory.counts=Object.fromEntries(Object.entries(x.inventory.counts).reverse());const b=createSyntheticMigrationPlan(x);assert.equal(b.ok,true);assert.equal(a.plan.inventory_sha256,b.plan.inventory_sha256);assert.equal(a.plan_sha256,b.plan_sha256);assert.equal(a.plan.archive_sha256,createHash('sha256').update(a.archive).digest('hex'));});
