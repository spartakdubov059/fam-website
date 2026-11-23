import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingImageStore } from '../media/pending-images.mjs';

test('private image store enforces per-upload limits on both source and converted WebP bytes', async () => {
  let writes = 0;
  const sharp = () => ({
    metadata: async () => ({ format: 'png' }),
    rotate() { return this; },
    resize() { return this; },
    webp() { return this; },
    toBuffer: async () => Buffer.alloc(5),
  });
  const store = createPendingImageStore({ sharp, putObject: async () => { writes++; }, bucket: 'private-test' });
  const input = { userId: '11111111-1111-4111-8111-111111111111', contentType: 'image/png' };
  await assert.rejects(store.put({ ...input, bytes: Buffer.alloc(3), maxBytes: 4 }), error => error.code === 'image_too_large');
  await assert.rejects(store.put({ ...input, bytes: Buffer.alloc(5), maxBytes: 4 }), /invalid image size/);
  assert.equal(writes, 0, 'oversized source and converted files never reach object storage');
});

test('private image store retries WebP conversion until the gateway response size limit is met', async () => {
  const qualities = [];
  const stored = [];
  const sharp = () => ({
    metadata: async () => ({ format: 'jpeg' }),
    rotate() { return this; },
    resize(options) { this.dimensions = options.width; return this; },
    webp(options) { qualities.push({ quality: options.quality, width: this.dimensions }); return this; },
    toBuffer: async () => Buffer.alloc(qualities.length === 1 ? 11 : 8),
  });
  const store = createPendingImageStore({ sharp, putObject: async input => stored.push(input), bucket: 'private-test', maxOutputBytes: 10 });
  const result = await store.put({ userId: '11111111-1111-4111-8111-111111111111', contentType: 'image/jpeg',
    bytes: Buffer.from([1, 2, 3]), maxBytes: 20 });
  assert.equal(result.bytes, 8);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].Body.length, 8);
  assert.deepEqual(qualities, [{ quality: 78, width: 1600 }, { quality: 68, width: 1600 }]);
});

test('private image store reduces dimensions after quality retries still exceed the response limit', async () => {
  const widths = [];
  const sharp = () => ({ metadata: async () => ({ format: 'png' }), rotate() { return this; },
    resize(options) { this.width = options.width; return this; }, webp() { widths.push(this.width); return this; },
    toBuffer: async function() { return Buffer.alloc(this.width === 1600 ? 1001 : 999); } });
  const store = createPendingImageStore({ sharp, putObject: async () => {}, bucket: 'private-test', maxOutputBytes: 1000 });
  const result = await store.put({ userId: '11111111-1111-4111-8111-111111111111', contentType: 'image/png',
    bytes: Buffer.from([1, 2, 3]), maxBytes: 2000 });
  assert.equal(result.bytes, 999);
  assert.deepEqual(widths, [1600, 1600, 1400]);
});

test('private image store refuses output that cannot fit the configured gateway response budget', async () => {
  const sharp = () => ({ metadata: async () => ({ format: 'webp' }), rotate() { return this; }, resize() { return this; },
    webp() { return this; }, toBuffer: async () => Buffer.alloc(11) });
  const store = createPendingImageStore({ sharp, putObject: async () => assert.fail('oversized image must not be stored'),
    bucket: 'private-test', maxOutputBytes: 10 });
  await assert.rejects(store.put({ userId: '11111111-1111-4111-8111-111111111111', contentType: 'image/webp',
    bytes: Buffer.from([1, 2, 3]), maxBytes: 20 }), error => error.code === 'image_too_large');
});
