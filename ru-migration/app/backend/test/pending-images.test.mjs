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
