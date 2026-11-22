import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler } from '../server.mjs';
import { createYandexFunctionHandler } from '../yandex-function.mjs';
import cloudFunction from '../cloud-function.cjs';

test('Yandex Cloud Functions CommonJS entrypoint loads the ES module handler', async () => {
  const response = await cloudFunction.handler({ httpMethod: 'GET', path: '/', headers: {}, body: '' }, {});
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.body, /FAM/);
});

test('Yandex function adapter serves the existing static Russian frontend with security headers', async () => {
  const handler = createYandexFunctionHandler({ requestHandler: createRequestHandler() });
  const response = await handler({ httpMethod: 'GET', path: '/', headers: {}, body: '' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.isBase64Encoded, false);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.body, /FAM/);
});

test('Yandex function adapter routes readiness requests and preserves query parameters', async () => {
  const handler = createYandexFunctionHandler({ requestHandler: createRequestHandler({
    getReadiness: async () => ({ ready: true, mode: 'synthetic' }),
  }) });
  const response = await handler({ httpMethod: 'GET', path: '/api/health',
    multiValueQueryStringParameters: { check: ['one', 'two'] }, headers: {}, body: '' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ready: true, mode: 'synthetic' });
});

test('Yandex function adapter forwards invocation context only to the backend handler', async () => {
  const context = { token: { access_token: 'synthetic-context-token' } };
  let received;
  const handler = createYandexFunctionHandler({ requestHandler: async (_req, res, invocation) => {
    received = invocation;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  } });
  await handler({ httpMethod: 'GET', path: '/', headers: {}, body: '' }, context);
  assert.equal(received, context);
});

test('Yandex function adapter preserves repeated Set-Cookie headers', async () => {
  const handler = createYandexFunctionHandler({ requestHandler: async (_req, res) => {
    res.writeHead(303, { location: '/', 'set-cookie': ['state=; Path=/; Max-Age=0', 'session=synthetic; Path=/; HttpOnly'] });
    res.end();
  } });
  const response = await handler({ httpMethod: 'GET', path: '/', headers: {}, body: '' });
  assert.equal(response.statusCode, 303);
  assert.deepEqual(response.multiValueHeaders['set-cookie'], ['state=; Path=/; Max-Age=0', 'session=synthetic; Path=/; HttpOnly']);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('Yandex function adapter suppresses HEAD and no-content response bodies', async () => {
  const handler = createYandexFunctionHandler({ requestHandler: async (req, res) => {
    res.writeHead(req.method === 'HEAD' ? 200 : 204, {
      'content-type': 'text/plain; charset=utf-8', 'content-length': '12',
    });
    res.end('representation');
  } });

  const head = await handler({ httpMethod: 'HEAD', path: '/', headers: {}, body: '' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '12');

  const noContent = await handler({ httpMethod: 'GET', path: '/', headers: {}, body: '' });
  assert.equal(noContent.statusCode, 204);
  assert.equal(noContent.body, '');
});

test('Yandex function adapter decodes request bytes and returns binary media as base64', async () => {
  const observed = [];
  const handler = createYandexFunctionHandler({ requestHandler: async (req, res) => {
    for await (const chunk of req) observed.push(chunk);
    res.writeHead(200, { 'content-type': 'image/webp' });
    res.end(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01]));
  } });
  const requestBytes = Buffer.from([0, 1, 2, 255]);
  const response = await handler({ httpMethod: 'POST', path: '/api/v1/media/pending', headers: {
    'Content-Type': 'application/octet-stream',
  }, body: requestBytes.toString('base64'), isBase64Encoded: true });
  assert.deepEqual(Buffer.concat(observed), requestBytes);
  assert.equal(response.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(response.body, 'base64'), Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01]));
});

test('Yandex function adapter rejects malformed base64 and hides backend exceptions', async () => {
  const invalid = createYandexFunctionHandler({ requestHandler: async () => { throw new Error('sensitive backend detail'); } });
  const badBody = await invalid({ httpMethod: 'POST', path: '/', headers: {}, body: '***', isBase64Encoded: true });
  assert.equal(badBody.statusCode, 400);
  const failure = await invalid({ httpMethod: 'GET', path: '/', headers: {}, body: '' });
  assert.equal(failure.statusCode, 500);
  assert.doesNotMatch(failure.body, /sensitive/);
});
