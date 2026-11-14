import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalSafetySignal } from '../policies/safety-signal.mjs';

const key = 'synthetic-test-secret-key-at-least-32-bytes';
const actor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', school_id: 'school-a' };
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('serious safety markers produce a keyed school-scoped pair digest without preserving content', () => {
  const input = { actor, targetId, sourceKind: 'message', sourceOrigin: 'messages', localFlag: 'serious_hate_or_threat',
    text: 'Поступали угрозы в адрес ученика. Его телефон +7 999 123-45-67', safetyKey: key };
  const signal = buildLocalSafetySignal(input);
  assert.equal(signal.category, 'threat_or_intimidation');
  assert.equal(signal.severity, 'high');
  assert.match(signal.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(signal.actorId, actor.id);
  assert.equal(signal.targetId, targetId);
  assert.equal(Object.hasOwn(signal, 'text'), false);
  assert.equal(Object.hasOwn(signal, 'evidenceExcerpt'), false);
  assert.equal(buildLocalSafetySignal(input).fingerprint, signal.fingerprint);
  assert.notEqual(buildLocalSafetySignal({ ...input, safetyKey: 'a-different-synthetic-secret-key-32b' }).fingerprint, signal.fingerprint);
  assert.notEqual(buildLocalSafetySignal({ ...input, actor: { ...actor, school_id: 'school-b' } }).fingerprint, signal.fingerprint);
});

test('serious hate markers are categorized and ambiguous markers stay medium severity', () => {
  const base = { actor, sourceKind: 'idea', sourceOrigin: 'ideas', localFlag: 'serious_hate_or_threat', safetyKey: key };
  assert.equal(buildLocalSafetySignal({ ...base, text: 'Дискриминация в классе.' }).category, 'hate_or_discrimination');
  assert.deepEqual(
    { category: buildLocalSafetySignal({ ...base, text: 'Сложная ситуация требует проверки.' }).category,
      severity: buildLocalSafetySignal({ ...base, text: 'Сложная ситуация требует проверки.' }).severity },
    { category: 'unclear_safety_signal', severity: 'medium' },
  );
});

test('non-safety local moderation flags do not create incident reports', () => {
  assert.equal(buildLocalSafetySignal({ actor, sourceKind: 'listing', sourceOrigin: 'listings',
    localFlag: 'controlled_substances', text: 'тест', safetyKey: key }), null);
});

test('safety incident recording requires a long key and valid same-school identities', () => {
  const base = { actor, sourceKind: 'message', sourceOrigin: 'messages', localFlag: 'serious_hate_or_threat', text: 'угроза' };
  assert.throws(() => buildLocalSafetySignal({ ...base, safetyKey: 'too-short' }), TypeError);
  assert.throws(() => buildLocalSafetySignal({ ...base, safetyKey: key, targetId: 'external-subject' }), TypeError);
});
