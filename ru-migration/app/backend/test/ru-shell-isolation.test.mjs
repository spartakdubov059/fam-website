import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');

test('Russian shell has no dormant direct Supabase client path', () => {
  assert.doesNotMatch(html, /window\.supabase|supabase\.createClient|\bsb\.(?:from|auth|functions|storage)\b/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=["']https?:/i);
  assert.match(html, /fetch\(["']\/api\/v1\/site-errors["']/);
});

test('Russian shell loads its user flows only from same-origin modules', () => {
  for (const path of [
    '/public-board.js',
    '/messages.js',
    '/listing-submit.js',
    '/listing-moderation.js',
    '/avatar-workflow.js',
    '/account-workflow.js',
    '/pulse.js',
  ]) {
    assert.ok(html.includes(path), `missing local module ${path}`);
  }
  assert.match(html, /Войти через Яндекс ID/);
  assert.match(html, /Российская копия работает отдельно от основного FAM/);
});
