import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createS3PendingImageStore } from '../app/backend/media/s3-pending-store.mjs';

const userId = '11111111-1111-4111-8111-111111111111';
const objects = new Map();
const requests = [];
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const [, bucket, ...keyParts] = url.pathname.split('/');
    const key = keyParts.map(decodeURIComponent).join('/');
    requests.push({ method: request.method, bucket, key, authorization: request.headers.authorization,
      contentType: request.headers['content-type'], encryption: request.headers['x-amz-server-side-encryption'] });
    if (bucket !== 'fam-synthetic-private' || !request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (!key || request.headers['x-amz-server-side-encryption'] !== 'AES256') {
        response.writeHead(400, { 'content-type': 'application/xml' });
        response.end('<Error><Code>InvalidRequest</Code></Error>');
        return;
      }
      objects.set(key, { body, contentType: request.headers['content-type'] || 'application/octet-stream' });
      response.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
      response.end();
      return;
    }
    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const matching = [...objects.entries()].filter(([objectKey]) => objectKey.startsWith(prefix));
      const contents = matching.map(([objectKey, item]) => `<Contents><Key>${xml(objectKey)}</Key><Size>${item.body.length}</Size><ETag>"${createHash('md5').update(item.body).digest('hex')}"</ETag><StorageClass>STANDARD</StorageClass></Contents>`).join('');
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fam-synthetic-private</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${matching.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      return;
    }
    if (request.method === 'GET' && key) {
      const item = objects.get(key);
      if (!item) {
        response.writeHead(404, { 'content-type': 'application/xml' });
        response.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'content-type': item.contentType, 'content-length': item.body.length,
        etag: `"${createHash('md5').update(item.body).digest('hex')}"` });
      response.end(item.body);
      return;
    }
    if (request.method === 'DELETE' && key) {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(400, { 'content-type': 'application/xml' });
    response.end('<Error><Code>NotImplemented</Code></Error>');
  } catch {
    response.writeHead(500, { 'content-type': 'application/xml' });
    response.end('<Error><Code>InternalError</Code></Error>');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const store = createS3PendingImageStore({
  FAM_RU_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
  FAM_RU_S3_BUCKET: 'fam-synthetic-private',
  FAM_RU_S3_ACCESS_KEY_ID: 'synthetic-access-key',
  FAM_RU_S3_SECRET_ACCESS_KEY: 'synthetic-secret-key',
  FAM_RU_S3_REGION: 'ru-central1',
});

try {
  const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const uploaded = await store.put({ userId, bytes: jpeg, contentType: 'image/jpeg' });
  assert.match(uploaded.key, new RegExp(`^pending/${userId}/[0-9a-f-]{36}\\.webp$`, 'i'));
  const stored = objects.get(uploaded.key);
  assert.ok(stored);
  assert.equal(stored.contentType, 'image/webp');
  assert.equal((await sharp(stored.body).metadata()).format, 'webp');
  assert.equal(uploaded.bytes, stored.body.length);

  const downloaded = await store.get(uploaded.key);
  assert.deepEqual(downloaded, stored.body);
  assert.deepEqual(await store.listUserObjects(userId), [uploaded.key]);
  assert.deepEqual(await store.listAccountObjects(userId, []), [uploaded.key]);
  assert.equal(await store.delete(uploaded.key), true);
  assert.deepEqual(await store.listUserObjects(userId), []);
  assert.deepEqual(requests.map(item => item.method), ['PUT', 'GET', 'GET', 'GET', 'DELETE', 'GET']);
  assert.ok(requests.every(item => item.authorization?.startsWith('AWS4-HMAC-SHA256 ')));
  assert.equal(requests.filter(item => item.method === 'PUT')[0].encryption, 'AES256');
  console.log('S3_SYNTHETIC_HTTP_UPLOAD_READ_LIST_DELETE_PASS');
} finally {
  store.close();
  await new Promise(resolve => server.close(resolve));
}
