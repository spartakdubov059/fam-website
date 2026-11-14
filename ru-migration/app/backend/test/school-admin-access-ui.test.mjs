import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');

test('Russian school role request screen uses only the same-origin YDB API', () => {
  assert.doesNotMatch(html, /school-admin-access|sb\.functions\.invoke\(\s*["']school-admin-access/);
  assert.match(html, /fetch\(\s*["']\/api\/v1\/role-requests["']/);
  assert.match(html, /fetch\(\s*["']\/api\/v1\/role-requests\/review["']/);
  assert.match(html, /requested_role:\s*requestedRole/);
  assert.match(html, /action:\s*["']start_review["']/);
  assert.match(html, /credentials:\s*["']same-origin["']/);
});
