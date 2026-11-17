import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
const submission = await readFile(new URL('../../web/listing-submit.js', import.meta.url), 'utf8');
const moderation = await readFile(new URL('../../web/listing-moderation.js', import.meta.url), 'utf8');
const notifications = await readFile(new URL('../../web/notifications.js', import.meta.url), 'utf8');
const shell = `${html}\n${submission}\n${moderation}\n${notifications}`;

test('Russian school role request screen uses only the same-origin YDB API', () => {
  assert.doesNotMatch(shell, /school-admin-access|sb\.functions\.invoke\(\s*["']school-admin-access/);
  assert.match(shell, /fetchImpl\(["']\/api\/v1\/role-requests["']/);
  assert.match(shell, /fetchImpl\(["']\/api\/v1\/role-requests\/review["']/);
  assert.match(shell, /requested_role:\s*select\.value/);
  assert.match(shell, /action:\s*["']start_review["']/);
  assert.match(shell, /credentials:\s*["']same-origin["']/);
});
