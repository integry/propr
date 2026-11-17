import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { apiSecurityHeaders, bodyParserErrorHandler, describeApiError, installApiFinalHandler } from '../apiErrorBoundary.js';
import { parseActivityPaging } from '../routes/queueRoutes.js';
import { isValidGitHubRepositoryPath } from '../routes/githubRoutes.js';

test('describeApiError maps parser, upload and server errors to safe JSON bodies', () => {
  assert.deepEqual(describeApiError(Object.assign(new SyntaxError('Unexpected end of JSON input at /usr/src/app'), { status: 400, type: 'entity.parse.failed' })),
    { status: 400, body: { error: 'Request body is not valid JSON', code: 'INVALID_JSON' } });
  assert.equal(describeApiError({ status: 413, type: 'entity.too.large' }).body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(describeApiError({ status: 415, type: 'charset.unsupported' }).status, 415);
  assert.equal(describeApiError({ status: 400, errno: -3, code: 'Z_DATA_ERROR' }).body.code, 'INVALID_REQUEST_BODY');
  assert.deepEqual(describeApiError({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' }), { status: 413, body: { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' } });
  assert.equal(describeApiError({ name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' }).status, 400);
  assert.deepEqual(describeApiError(new Error('/usr/src/app/secret.js')), { status: 500, body: { error: 'Internal server error', code: 'INTERNAL_ERROR' } });
  assert.equal(describeApiError({ status: 42 }).status, 500);
  assert.equal(describeApiError({ statusCode: 404 }).body.code, 'NOT_FOUND');
});

test('final handler, parser handler and headers on a bare Express app', async t => {
  const app = express();
  app.disable('x-powered-by');
  installApiFinalHandler(app);
  app.use(apiSecurityHeaders);
  app.use(express.json({ limit: '10b' }));
  app.use(bodyParserErrorHandler);
  app.get('/denied', (_req, res) => { res.status(401).json({ error: 'nope' }); });
  app.get('/challenge', (_req, res) => { res.set('WWW-Authenticate', 'Bearer resource_metadata="x"').status(401).end(); });
  app.get('/boom', () => { throw new Error('/usr/src/app/file.js'); });
  app.post('/echo', (req, res) => { res.json(req.body); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const denied = await fetch(`${base}/denied`);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
  assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/challenge`)).headers.get('www-authenticate'), 'Bearer resource_metadata="x"');
  assert.equal((await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
  const tooLarge = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":"0123456789"}' });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
  const boom = await fetch(`${base}/boom`);
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { error: 'Internal server error', code: 'INTERNAL_ERROR' });
  const missing = await fetch(`${base}/nothing-here`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-powered-by'), null);
  assert.deepEqual(await missing.json(), { error: 'Not found', code: 'NOT_FOUND' });
  const head = await fetch(`${base}/nothing-here`, { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), '');
});

test('parseActivityPaging accepts bounded integers only', () => {
  assert.deepEqual(parseActivityPaging({}), { limit: 50, offset: 0 });
  assert.deepEqual(parseActivityPaging({ limit: '1', offset: '0' }), { limit: 1, offset: 0 });
  assert.deepEqual(parseActivityPaging({ limit: '200', offset: '1000' }), { limit: 200, offset: 1000 });
  for (const query of [{ limit: '0' }, { limit: '201' }, { limit: '-1' }, { limit: 'abc' }, { limit: '1e2' }, { limit: '' }, { limit: ['1', '2'] },
    { offset: '-1' }, { offset: '99999999999999999999' }, { offset: '1.5' }, { offset: '0x10' }]) {
    assert.ok('error' in parseActivityPaging(query), JSON.stringify(query));
  }
});

test('isValidGitHubRepositoryPath refuses traversal and non-name characters', () => {
  assert.equal(isValidGitHubRepositoryPath('integry', 'propr'), true);
  assert.equal(isValidGitHubRepositoryPath('my-org_1', 'repo.name-2_x'), true);
  for (const [owner, repo] of [['../../etc/passwd', 'propr'], ['integry', '..'], ['integry', '.'], ['integry', 'a/b'], ['', 'propr'], ['integry', ''],
    ['in tegry', 'propr'], ['integry.', 'propr'], ['x'.repeat(101), 'propr'], [undefined, 'propr']] as const) {
    assert.equal(isValidGitHubRepositoryPath(owner, repo), false, `${owner}/${repo}`);
  }
});
