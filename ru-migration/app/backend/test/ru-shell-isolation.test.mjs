import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../../web/shell-bootstrap.js', import.meta.url), 'utf8');
const shell = `${html}\n${bootstrap}`;

test('Russian shell has no dormant direct Supabase client path', () => {
  assert.doesNotMatch(shell, /window\.supabase|supabase\.createClient|\bsb\.(?:from|auth|functions|storage)\b/);
  assert.doesNotMatch(shell, /<script\b[^>]*\bsrc=["']https?:/i);
  assert.match(bootstrap, /fetch\(["']\/api\/v1\/site-errors["']/);
});

test('Russian shell loads its user flows only from same-origin modules', () => {
  for (const path of [
    '/public-board.js',
    '/messages.js',
    '/listing-submit.js',
    '/listing-moderation.js',
    '/avatar-workflow.js',
    '/profile-settings.js',
    '/navigation.js',
    '/hero-carousel.js',
    '/idea-history.js',
    '/account-workflow.js',
    '/pulse.js',
  ]) {
    assert.ok(shell.includes(path), `missing local module ${path}`);
  }
  assert.match(shell, /Войти через Яндекс ID/);
  assert.match(shell, /Российская копия работает отдельно от основного FAM/);
  assert.match(html, /<script src="\/shell-bootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script\s*>[\s\S]*?<\/script>/i);
  assert.match(html, /<link rel="stylesheet" href="\/shell\.css">/);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.match(bootstrap, /document\.body\.innerHTML\s*=/);
  assert.match(bootstrap, /id="ruIdeaHistory"/);
  assert.match(bootstrap, /id="ruHeroTrack"/);
  assert.match(bootstrap, /id="ruTabbar"/);
  assert.match(bootstrap, /id="ruAfishaFeed"[\s\S]*id="ruPulse"[\s\S]*id="publicListings"/);
  assert.match(bootstrap, /data-ru-view="afisha"/);
});
