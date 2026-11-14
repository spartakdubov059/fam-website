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

test('S3 photo reads validate scoped keys and byte content before returning bytes', async () => {
  let request;
  const store = createS3PendingImageStore(env, { get: async input => {
    request = input;
    return { ContentType: 'image/webp', ContentLength: 4, Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3, 4]) } };
  } });
  const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  assert.deepEqual([...await store.get(key)], [1, 2, 3, 4]);
  assert.equal(request.Bucket, 'private-test');
  assert.equal(request.Key, key);
  await assert.rejects(store.get('pending/../../private.webp'), /invalid private image key/);
  await store.close();
});

test('S3 pending image deletion accepts only scoped image keys', async () => {
  let request;
  const store = createS3PendingImageStore(env, { remove: async input => { request = input; } });
  const key = 'pending/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  assert.equal(await store.delete(key), true);
  assert.deepEqual(request, { Bucket: 'private-test', Key: key });
  await assert.rejects(store.delete('pending/../../private.webp'), /invalid private image key/);
  await store.close();
});

test('S3 account inventory paginates only validated objects below the account prefix', async () => {
  const requests = [];
  const userId = '11111111-1111-4111-8111-111111111111';
  const key = `pending/${userId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
  const store = createS3PendingImageStore(env, { list: async input => {
    requests.push(input);
    return requests.length === 1
      ? { Contents: [{ Key: key }], IsTruncated: true, NextContinuationToken: 'next-page' }
      : { Contents: [], IsTruncated: false };
  } });
  assert.deepEqual(await store.listUserObjects(userId), [key]);
  assert.equal(requests[0].Prefix, `pending/${userId}/`);
  assert.equal(requests[1].ContinuationToken, 'next-page');
  await assert.rejects(store.listUserObjects('../../other'), /invalid image owner/);
  await store.close();
});
