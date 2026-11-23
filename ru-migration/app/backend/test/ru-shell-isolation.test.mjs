import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../../web/shell-bootstrap.js', import.meta.url), 'utf8');
const shellCss = await readFile(new URL('../../web/shell.css', import.meta.url), 'utf8');
const shell = `${html}\n${bootstrap}\n${shellCss}`;

test('Russian shell has no dormant direct Supabase client path', () => {
  assert.doesNotMatch(shell, /window\.supabase|supabase\.createClient|\bsb\.(?:from|auth|functions|storage)\b/);
  assert.doesNotMatch(shell, /supabase/i, 'the isolated Russian frontend has no Supabase code or stale diagnostics');
  assert.doesNotMatch(shell, /<script\b[^>]*\bsrc=["']https?:/i);
  assert.match(bootstrap, /fetch\(["']\/api\/v1\/site-errors["']/);
});

test('Russian shell loads its user flows only from same-origin modules', () => {
  for (const path of [
    '/public-board.js',
    '/messages.js',
    '/listing-submit.js',
    '/category-hints.js',
    '/description-helper.js',
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

test('Russian shell includes all twelve same-origin FAM photo banners', async () => {
  const bannerPaths = [...bootstrap.matchAll(/src="\/assets\/(banner-\d+\.webp)"/g)].map(match => match[1]);
  assert.deepEqual(bannerPaths, Array.from({ length: 12 }, (_, index) => `banner-${index + 1}.webp`));
  for (const banner of bannerPaths) {
    const bytes = await readFile(new URL(`../../web/assets/${banner}`, import.meta.url));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${banner} must be a local RIFF image`);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `${banner} must be WebP`);
    assert.ok(bytes.length > 10_000 && bytes.length < 500_000, `${banner} must be a complete, bounded image`);
  }
  assert.match(shellCss, /#ruHeroTrack\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(shellCss, /#ruHeroTrack > \.hero-slide\.hero-img > img\s*\{[^}]*object-fit:\s*cover/s);
});
