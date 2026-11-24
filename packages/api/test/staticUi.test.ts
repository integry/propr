import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { installApiFinalHandler } from '../apiErrorBoundary.js';
import { mountStaticUi, publicOriginOf, renderRuntimeConfigScript, resolveStaticUi } from '../staticUi.js';

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'propr-ui-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/config.js"></script><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(dist, 'service-worker.js'), 'self.addEventListener("fetch", () => {})');
  // The bundle ships a static default config.js; the generated one must win.
  writeFileSync(join(dist, 'config.js'), 'window.__PROPR_CONFIG__ = {"apiBaseUrl":"stale"};');
  return dist;
}

let baseUrl = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;

before(async () => {
  const app = express();
  installApiFinalHandler(app);
  mountStaticUi(app, { distDir: makeDist(), publicApiUrl: '' });
  app.get('/api/status', (_req, res) => { res.json({ ok: true }); });
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); });

const html = { accept: 'text/html,application/xhtml+xml' };

test('config.js is generated at runtime, same-origin by default, and never cached', async () => {
  const res = await fetch(`${baseUrl}/config.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(await res.text(), 'window.__PROPR_CONFIG__ = {"apiBaseUrl":""};\n');
});

test('the runtime config escapes line terminators that break a JS string literal', () => {
  assert.equal(
    renderRuntimeConfigScript('https://x.example/ </script>'),
    'window.__PROPR_CONFIG__ = {"apiBaseUrl":"https://x.example/\\u2028</script>"};\n',
  );
});

test('client-side routes fall back to index.html for navigations', async () => {
  for (const path of ['/', '/inbox', '/tasks/123', '/settings/agents']) {
    const res = await fetch(`${baseUrl}${path}`, { headers: html });
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<div id="root">/, path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', path);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', path);
  }
});

test('hashed assets are immutable and the service worker revalidates', async () => {
  const asset = await fetch(`${baseUrl}/assets/index-abc123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  const worker = await fetch(`${baseUrl}/service-worker.js`);
  assert.equal(worker.headers.get('cache-control'), 'no-cache, must-revalidate');
});

test('missing assets and server-owned paths are never answered with index.html', async () => {
  const missing = await fetch(`${baseUrl}/assets/index-old.js`, { headers: html });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /<div id="root">/);

  const api = await fetch(`${baseUrl}/api/status`, { headers: html });
  assert.deepEqual(await api.json(), { ok: true });
  for (const path of ['/api/unknown', '/mcp/consent', '/.well-known/oauth-authorization-server', '/socket.io/', '/webhook']) {
    const res = await fetch(`${baseUrl}${path}`, { headers: html });
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('content-type') ?? '', /json/, path);
  }
  // Non-navigation requests (JSON clients) get the API's 404, not the SPA.
  const json = await fetch(`${baseUrl}/inbox`, { headers: { accept: 'application/json' } });
  assert.equal(json.status, 404);
  // Mutations never reach the SPA fallback.
  const post = await fetch(`${baseUrl}/inbox`, { method: 'POST', headers: html });
  assert.equal(post.status, 404);
});

test('serving is opt-in and reports a requested but missing bundle', () => {
  assert.equal(resolveStaticUi({}, '/nowhere').enabled, false);
  assert.equal(resolveStaticUi({ PROPR_SERVE_UI: '0' }, '/nowhere').enabled, false);
  const missing = resolveStaticUi({ PROPR_SERVE_UI: '1' }, '/nowhere');
  assert.equal(missing.enabled, false);
  assert.match(missing.reason ?? '', /no built UI/);

  const dist = makeDist();
  const explicit = resolveStaticUi({ PROPR_UI_DIST_DIR: dist, PROPR_SERVED_UI_API_URL: 'https://api.example.com' });
  assert.deepEqual(explicit, { enabled: true, distDir: dist, publicApiUrl: 'https://api.example.com' });

  const root = mkdtempSync(join(tmpdir(), 'propr-app-root-'));
  mkdirSync(join(root, 'propr-ui', 'dist'), { recursive: true });
  writeFileSync(join(root, 'propr-ui', 'dist', 'index.html'), '<!doctype html>');
  assert.equal(resolveStaticUi({ PROPR_SERVE_UI: 'true' }, root).distDir, join(root, 'propr-ui', 'dist'));
});

test('publicOriginOf accepts only http(s) URLs', () => {
  assert.equal(publicOriginOf('https://propr.example.com/path?q=1'), 'https://propr.example.com');
  assert.equal(publicOriginOf('http://localhost:4000'), 'http://localhost:4000');
  assert.equal(publicOriginOf('ftp://example.com'), undefined);
  assert.equal(publicOriginOf('not a url'), undefined);
  assert.equal(publicOriginOf(undefined), undefined);
});
