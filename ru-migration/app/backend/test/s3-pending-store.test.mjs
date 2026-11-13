import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createS3PendingImageStore } from '../media/s3-pending-store.mjs';
const env = { FAM_RU_S3_ENDPOINT: 'https://storage.example.invalid', FAM_RU_S3_BUCKET: 'private-test', FAM_RU_S3_ACCESS_KEY_ID: 'synthetic', FAM_RU_S3_SECRET_ACCESS_KEY: 'synthetic' };
test('S3 adapter passes transformed image to the configured private bucket', async () => {
  let request;
  const store = createS3PendingImageStore(env, { send: async (input) => { request = input; } });
  const bytes = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const result = await store.put({ userId: '11111111-1111-4111-8111-111111111111', bytes, contentType: 'image/jpeg' });
  assert.equal(request.Bucket, 'private-test');
  assert.equal(request.ContentType, 'image/webp');
  assert.equal(request.ServerSideEncryption, 'AES256');
  assert.equal((await sharp(request.Body).metadata()).format, 'webp');
  assert.match(result.key, /^pending\//);
  await store.close();
});
test('S3 adapter fails closed without explicit credentials or with unsafe remote HTTP', () => {
  assert.throws(() => createS3PendingImageStore({}), /not configured/);
  assert.throws(() => createS3PendingImageStore({ ...env, FAM_RU_S3_ENDPOINT: 'http://storage.example.invalid' }), /HTTPS/);
});
