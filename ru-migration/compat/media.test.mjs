import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createPendingImageStore } from '../app/backend/media/pending-images.mjs';
const userId = '11111111-1111-4111-8111-111111111111';
const image = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#3178c6' } }).jpeg().withMetadata({ density: 300 }).toBuffer();
test('stores only normalized WebP in a user scoped private pending key', async () => {
  let request;
  const store = createPendingImageStore({ sharp, bucket: 'fam-ru-private-test', putObject: async (x) => { request = x; } });
  const result = await store.put({ userId, bytes: image, contentType: 'image/jpeg' });
  assert.match(result.key, new RegExp(`^pending/${userId}/[0-9a-f-]{36}\\.webp$`));
  assert.equal(request.ContentType, 'image/webp');
  assert.equal(request.ServerSideEncryption, 'AES256');
  const metadata = await sharp(request.Body).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
});
test('rejects invalid ownership, MIME, oversized and disguised image data before storage', async () => {
  let writes = 0;
  const store = createPendingImageStore({ sharp, bucket: 'test', maxBytes: image.length + 1, putObject: async () => { writes++; } });
  await assert.rejects(store.put({ userId: '../other', bytes: image, contentType: 'image/jpeg' }));
  await assert.rejects(store.put({ userId, bytes: image, contentType: 'text/plain' }));
  await assert.rejects(store.put({ userId, bytes: Buffer.concat([image, image]), contentType: 'image/jpeg' }));
  await assert.rejects(store.put({ userId, bytes: Buffer.from('not an image'), contentType: 'image/jpeg' }));
  assert.equal(writes, 0);
});
