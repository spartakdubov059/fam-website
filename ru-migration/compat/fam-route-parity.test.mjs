import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../app/backend/server.mjs', import.meta.url), 'utf8');
const web = readFileSync(new URL('../app/web/index.html', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../app/web/shell-bootstrap.js', import.meta.url), 'utf8');

const coreRoutes = [
  '/api/v1/listings',
  '/api/v1/ideas',
  '/api/v1/messages',
  '/api/v1/favorites',
  '/api/v1/me',
  '/api/v1/event-registrations',
  '/api/v1/pulse',
  '/api/v1/notifications/listings',
  '/api/v1/school/admin/overview',
  '/api/v1/suspensions',
  '/api/v1/deletion-requests',
  '/api/v1/avatars/moderation',
  '/api/v1/internal/coder-task',
];

test('FAM RU core routes cover listings, ideas, messages, profile, pulse and administration', () => {
  for (const route of coreRoutes) assert.ok(server.includes(route), `missing core route ${route}`);
});

test('FAM RU mobile shell keeps board, afisha, messages and profile navigation', () => {
  for (const fragment of ['ru-tabbar', 'Афиша', 'Сообщения', 'Профиль', 'Доска']) {
    assert.match(`${web}\n${shell}`, new RegExp(fragment, 'i'), `missing mobile fragment ${fragment}`);
  }
});

test('FAM RU uses same-origin APIs and does not expose Supabase browser credentials', () => {
  assert.doesNotMatch(`${web}\n${shell}`, /supabase\.co|SUPABASE_SERVICE|SUPABASE_SECRET/i);
  assert.ok(shell.includes('/api/v1/') || web.includes('/api/v1/'));
});
