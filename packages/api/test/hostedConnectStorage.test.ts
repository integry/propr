import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import cors from 'cors';
import session from 'express-session';
import { chromium } from 'playwright';
import { createConnectStorageCorsMiddleware, createCorsOriginValidator, corsRejectionHandler } from '../corsValidation.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-storage-'));
const environment = {
  DATA_DIR: root, DB_FILENAME: path.join(root, 'fixture.sqlite'), PROPR_DEMO_MODE: 'false',
  FRONTEND_URL: 'https://app.propr.dev', API_PUBLIC_URL: 'https://t-storage-test.propr.dev',
  PROPR_CONNECT_URL: 'https://connect.propr.dev', PROPR_WEB_AUTH_MODE: 'disabled',
  SESSION_SECRET: 'isolated-hosted-storage-test-session-secret-2979',
  PROPR_GH_RELAY_URL: 'https://unused.invalid/v1', PROPR_GH_RELAY_TOKEN: 'isolated-fixture-only',
  PROPR_ADMIN_USERS: '', GITHUB_USER_WHITELIST: '', COOKIE_DOMAIN: '',
};
const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
// Replace Redis transport only. Production setupAuth, Passport serialization,
// session regeneration, cookie settings and per-request authorization all run.
const store = new session.MemoryStore();
await mock.module('connect-redis', { namedExports: { RedisStore: function () { return store; } } });
await mock.module('redis', { namedExports: { createClient: () => ({ on() {}, async connect() {} }) } });
const { InstanceStorageService } = await import('../../core/src/storage/service.js');
const { taskHistoryControl } = await import('../../core/src/storage/taskHistoryControl.js');
const { StorageLifecycle } = await import('../../core/src/storage/lifecycle.js');
const { setupAuth, ensureAuthenticated, createConnectCallbackHandler } = await import('../auth.js');
const { resolveAuthorization } = await import('../authorization.js');
const { db, closeConnection } = await import('@propr/core');
const { createInstanceStorageRoutes } = await import('../routes/instanceStorageRoutes.js');
const { createStorageRouteEntries } = await import('../instanceStorageRouteRegistry.js');
const { registerRouteEntries } = await import('../routeRegistry.js');
after(async () => {
  await closeConnection();
  await fs.rm(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function corsBoundary(app: express.Express, env = environment) {
  app.use(createConnectStorageCorsMiddleware(env));
  const standard = cors({ origin: createCorsOriginValidator(env.FRONTEND_URL, undefined), credentials: true });
  app.use((req, res, next) => res.locals.connectStorageCors ? next() : standard(req, res, next));
  app.use(corsRejectionHandler);
}

test('hosted Connect CORS grants only exact configured origin, routes, methods and headers', async t => {
  const app = express(); corsBoundary(app);
  app.use((_req, res) => res.sendStatus(401));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = environment.PROPR_CONNECT_URL;
  const preflight = (url: string, method: string, headers = '', from = origin) => fetch(base + url, {
    method: 'OPTIONS', headers: { Origin: from, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers },
  });
  const storage = '/api/instance/storage/v1';
  for (const [url, method] of [
    ['/api/auth/user', 'GET'], [`${storage}/usage`, 'GET'], [`${storage}/policy`, 'GET'],
    [`${storage}/policy`, 'PUT'], [`${storage}/cleanup/preview`, 'POST'], [`${storage}/cleanup/execute`, 'POST'],
    [`${storage}/cleanup/operations/12345678-1234-4234-8234-123456789abc`, 'GET'],
  ]) {
    const mutation = method !== 'GET';
    const response = await preflight(url, method, mutation ? 'Content-Type, X-ProPR-Storage' : '');
    assert.equal(response.status, 204, `${method} ${url}`);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), method);
    assert.equal(response.headers.get('access-control-allow-headers'), mutation ? 'content-type,x-propr-storage' : null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await fetch(base + url, { method, headers: { Origin: origin } })).status, 401, 'CORS does not authenticate');
  }
  for (const from of ['https://evil.example', 'https://connect.propr.dev.evil.example', 'null',
    'http://connect.propr.dev', 'https://connect.propr.dev:8443', 'https://pr-42.propr.dev', 'https://t-other.propr.dev']) {
    const response = await preflight(`${storage}/policy`, 'PUT', 'content-type,x-propr-storage', from);
    assert.equal(response.status, 403, from);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal((await fetch(base + `${storage}/usage`, { headers: { Origin: from } })).status, 403);
  }
  for (const url of ['/api/tasks', '/socket.io/', '/api/auth/logout', '/api/auth/github', `${storage}/usage/`, `${storage}/cleanup/execute/extra`]) {
    assert.equal((await preflight(url, 'GET')).status, 403, url);
  }
  for (const method of ['DELETE', 'PATCH', 'HEAD', 'POST']) assert.equal((await preflight(`${storage}/policy`, method)).status, 403);
  for (const headers of ['authorization', 'x-propr-desktop-transport-scope', 'content-type,x-unknown']) {
    assert.equal((await preflight(`${storage}/policy`, 'PUT', headers)).status, 403);
  }
  const shared = createCorsOriginValidator(environment.FRONTEND_URL, undefined);
  shared(origin, error => assert.ok(error, 'Socket.IO shared validator stays closed'));
});

test('unsupported public endpoints and invalid Connect configuration do not acquire hosted authority', () => {
  for (const publicUrl of ['https://customer.example', 'http://t-test.propr.dev', 'https://t-test.propr.dev:443', 'https://t-test.propr.dev.evil.example', 'https://preview.propr.dev']) {
    const handler = createConnectStorageCorsMiddleware({ ...environment, API_PUBLIC_URL: publicUrl });
    let forwarded = false;
    handler({ get: () => environment.PROPR_CONNECT_URL } as never, {} as never, error => { assert.equal(error, undefined); forwarded = true; });
    assert.ok(forwarded, publicUrl);
  }
  for (const value of ['null', 'http://connect.propr.dev', 'https://connect.propr.dev/path', 'https://connect.propr.dev?x=1']) {
    assert.throws(() => createConnectStorageCorsMiddleware({ ...environment, PROPR_CONNECT_URL: value }));
  }
});

test('real HTTPS hosted session, storage authority and Connect frontend', async t => {
  await db.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  await db('instance_members').insert([{ github_user_id: '42', role: 'admin', source: 'local' }, { github_user_id: '43', role: 'admin', source: 'local' }]);
  const { up: profiles } = await import('../../core/src/db/migrations/20261012000000_create_github_user_profiles.js');
  await profiles(db);
  await db.schema.createTable('tasks', table => table.string('task_id').primary());
  await db.schema.createTable('task_history', table => { table.increments('history_id'); table.string('task_id'); table.string('state'); });
  await db.schema.createTable('llm_executions', table => { table.increments('execution_id'); table.string('task_id'); table.string('end_time'); });
  await db.schema.createTable('llm_execution_details', table => table.integer('execution_id'));
  await db.schema.createTable('task_assignees', table => table.string('task_id'));
  await db('tasks').insert({ task_id: 'disposable-completed-task' });
  await db('task_history').insert({ task_id: 'disposable-completed-task', state: 'completed' });
  const owned = path.join(root, 'disposable-config'); await fs.writeFile(owned, 'isolated disposable storage observation\n');
  const service = new InstanceStorageService({ lifecycle: new StorageLifecycle(path.join(root, 'control')), clonesRoot: path.join(root, 'clones'),
    roots: [{ category: 'database_config', path: owned }], taskHistory: taskHistoryControl(db), hasPendingTasks: async () => false });
  const app = express();
  // Bound both fixture apps before authentication and file-serving handlers.
  // Each app has its own in-memory budget with room for browser acceptance.
  app.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  const instance = express();
  instance.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  corsBoundary(instance); instance.use(express.json()); setupAuth(instance, false);
  app.use((req, res, next) => req.hostname === 't-storage-test.propr.dev' ? instance(req, res, next) : next());
  // Local test-only identity provider: exercise the production Connect callback
  // with an isolated grant redeemer; never contact a real relay or GitHub account.
  instance.get('/fixture/login/:actor', (req, res) => {
    (req.session as session.Session & { connectOAuthState: string }).connectOAuthState = 'isolated-state';
    req.session.save(() => res.redirect(`/fixture/callback?state=isolated-state&code=${req.params.actor}`));
  });
  instance.get('/fixture/callback', createConnectCallbackHandler(async ({ code }) => ({
    id: code, login: `fixture-${code}`, username: `fixture-${code}`, displayName: 'Isolated test administrator',
    email: null, avatarUrl: null, accessToken: 'isolated-test-only',
  })));
  instance.use('/api/instance/storage', ensureAuthenticated, resolveAuthorization);
  registerRouteEntries(instance, createStorageRouteEntries(createInstanceStorageRoutes(service)));
  const frontend = process.env.CONNECT_STORAGE_FRONTEND_DIST;
  // Isolated Connect control-plane fixture, served over HTTP rather than browser
  // response interception. Instance API/session/storage responses are production.
  app.get('/v1/auth/me', (_req, res) => res.json({ github_user_id: 42, username: 'fixture-admin', avatar_url: null,
    installations: [{ installation_id: 1, account_login: 'isolated-test', account_type: 'Organization', authorization_role: 'owner' }] }));
  app.get('/v1/billing/summary', (_req, res) => res.json({ installation_id: 1, has_plus_access: true, allowed_seats: 3, active_seats: 1 }));
  app.get('/v1/tunnels', (_req, res) => res.json({ tunnels: [{ tunnel_id: 'storage-test', installation_id: 1,
    hostname: 't-storage-test.propr.dev', tunnel_url: environment.API_PUBLIC_URL, created_at: new Date().toISOString() }] }));
  app.get('/v1/tunnels/health', (_req, res) => res.json({ status: 'compatible', connector_online: true, root_blocked: true, socket_io_reachable: true, propr_version: '0.9.0' }));
  if (frontend) { app.use(express.static(frontend)); app.get('/{*path}', (_req, res) => res.sendFile(path.join(frontend, 'index.html'))); }
  else app.get('/fixture', (_req, res) => res.send('<html><title>Isolated Connect origin</title></html>'));
  const key = path.join(root, 'key.pem'); const cert = path.join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=connect.propr.dev',
    '-addext', 'subjectAltName=DNS:connect.propr.dev,DNS:t-storage-test.propr.dev,DNS:app.propr.dev,DNS:preview.propr.dev', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const server = createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), args: ['--no-sandbox', '--no-proxy-server',
    `--host-resolver-rules=MAP connect.propr.dev:443 127.0.0.1:${port}, MAP t-storage-test.propr.dev:443 127.0.0.1:${port}, MAP app.propr.dev:443 127.0.0.1:${port}, MAP preview.propr.dev:443 127.0.0.1:${port}`] });
  t.after(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  const api = environment.API_PUBLIC_URL;
  const login = async (actor: string) => { await page.goto(`${api}/fixture/login/${actor}`); await page.goto(`${environment.PROPR_CONNECT_URL}/fixture`); };
  const request = (endpoint: string, method = 'GET', body?: object, marker = true) => page.evaluate(async ({ api, endpoint, method, body, marker }) => {
    const response = await fetch(`${api}/api/${endpoint}`, { method, credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json', ...(marker ? { 'X-ProPR-Storage': '1' } : {}) } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }, { api, endpoint, method, body, marker });
  const base = 'instance/storage/v1';
  await page.goto(`${environment.PROPR_CONNECT_URL}/fixture`);
  assert.equal((await request(`${base}/usage`)).status, 401);
  assert.equal((await request(`${base}/policy`, 'PUT', { instanceId: 'untrusted', enabled: true, idleHours: 24 })).status, 401, 'successful preflight grants no mutation authority');
  await login('42');
  const cookie = (await context.cookies(api)).find(value => value.name === 'connect.sid');
  assert.ok(cookie); assert.equal(cookie.domain, 't-storage-test.propr.dev'); assert.equal(cookie.sameSite, 'Lax'); assert.ok(cookie.secure && cookie.httpOnly);
  assert.equal((await request('auth/user')).body.id, '42');
  const usage = await request(`${base}/usage`); assert.equal(usage.status, 200);
  const instanceId = usage.body.instanceId;
  assert.deepEqual((await request(`${base}/policy`)).body.policy, { enabled: false, idleHours: 24 });
  assert.equal((await request(`${base}/policy`, 'PUT', { instanceId, enabled: true, idleHours: 24 }, false)).status, 403);
  assert.equal((await request(`${base}/policy`, 'PUT', { instanceId, enabled: true, idleHours: 24 })).status, 200);
  await request(`${base}/policy`, 'PUT', { instanceId, enabled: false, idleHours: 24 });
  assert.equal((await request(`${base}/cleanup/preview`, 'POST', { instanceId: 'foreign', categories: ['repository_caches'] })).status, 409);
  const preview = (await request(`${base}/cleanup/preview`, 'POST', { instanceId, categories: ['task_history'], taskIds: ['disposable-completed-task'] })).body;
  const execute = { instanceId, confirmation: preview.confirmation };
  await login('43'); assert.equal((await request(`${base}/cleanup/execute`, 'POST', execute)).status, 403);
  assert.equal((await request(`${base}/cleanup/operations/${preview.confirmation}?instanceId=${instanceId}`)).status, 404);
  await login('42'); assert.equal((await request(`${base}/cleanup/execute`, 'POST', execute)).status, 200);
  assert.equal((await request(`${base}/cleanup/execute`, 'POST', execute)).status, 409);
  assert.equal((await request(`${base}/cleanup/operations/${preview.confirmation}?instanceId=${instanceId}`)).status, 200);
  assert.equal(await db('tasks').where({ task_id: 'disposable-completed-task' }).first(), undefined);
  assert.equal(await fs.readFile(owned, 'utf8'), 'isolated disposable storage observation\n');
  await db('instance_members').where({ github_user_id: '42' }).update({ role: 'member' });
  for (const [endpoint, method, body] of [
    ['usage', 'GET'], ['policy', 'GET'], ['policy', 'PUT', { instanceId, enabled: true, idleHours: 24 }],
    ['cleanup/preview', 'POST', { instanceId, categories: ['repository_caches'] }],
    ['cleanup/execute', 'POST', execute], [`cleanup/operations/${preview.confirmation}?instanceId=${instanceId}`, 'GET'],
  ] as Array<[string, string, object?]>) {
    assert.equal((await request(`${base}/${endpoint}`, method, body)).status, 403, `demotion takes effect on ${method} ${endpoint}`);
  }
  await db('instance_members').where({ github_user_id: '42' }).update({ role: 'admin' });

  if (frontend) {
    const { expect } = await import('playwright/test');
    await expect.poll(async () => (await request(`${base}/usage`)).body.ownedBytes).toBeGreaterThan(0);
    await db('tasks').insert({ task_id: 'disposable-ui-task' });
    await db('task_history').insert({ task_id: 'disposable-ui-task', state: 'completed' });
    await context.addInitScript(() => {
      sessionStorage.setItem('propr-routing.auth.token', 'isolated-control-plane-session');
      localStorage.setItem('propr-routing.installation.id', '1');
      localStorage.setItem('propr-routing.help-banner.dismissed', 'true');
    });
    page.on('console', message => { if (message.type() === 'error') t.diagnostic(message.text()); });
    page.on('response', response => { if (response.status() >= 400) t.diagnostic(`${response.status()} ${response.url()}`); });
    await page.goto(`${environment.PROPR_CONNECT_URL}/tunnels`);
    await page.getByRole('button', { name: 'Storage and private data' }).click();
    const dialog = page.getByRole('dialog');
    const optIn = dialog.getByRole('checkbox', { name: /Enable safe/ });
    await expect(optIn).toBeEnabled(); await expect(optIn).not.toBeChecked();
    await expect(dialog.getByText(/24/).first()).toBeVisible();
    await expect(dialog.getByText(/KiB/).first()).toBeVisible();
    await fs.mkdir('.propr/previews', { recursive: true });
    await dialog.screenshot({ path: '.propr/previews/hosted-storage.png' });
    await optIn.check();
    await dialog.getByRole('button', { name: /Save/ }).click();
    await expect.poll(async () => (await service.policy()).enabled).toBe(true);
    await dialog.getByLabel('Cleanup scope').selectOption('task_history');
    await dialog.getByLabel(/Terminal task IDs/).fill('disposable-ui-task');
    await dialog.getByRole('button', { name: 'Preview selected cleanup' }).click();
    const confirm = dialog.getByRole('button', { name: 'Confirm selected cleanup' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /I confirm local deletion/ }).check();
    await dialog.screenshot({ path: '.propr/previews/hosted-confirmation.png' });
    await confirm.click();
    await expect(dialog.getByText(/1 candidates deleted/)).toBeVisible();
    assert.equal(await db('tasks').where({ task_id: 'disposable-ui-task' }).first(), undefined);
    await login('43');
    await page.goto(`${environment.PROPR_CONNECT_URL}/tunnels`);
    await page.getByRole('button', { name: 'Storage and private data' }).click();
    await expect(dialog.getByRole('alert')).toContainText('same account');
    await expect(optIn).toBeDisabled();
    await expect(dialog.getByText(/Usage unknown/)).toBeVisible();
    await login('42');
    await page.goto('https://preview.propr.dev/tunnels');
    await page.getByRole('button', { name: 'Storage and private data' }).click();
    await expect(page.getByRole('dialog').getByText(/Usage unknown/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Enable safe/ })).toBeDisabled();
    await page.getByRole('dialog').screenshot({ path: '.propr/previews/unsupported-origin.png' });
    await fs.writeFile('.propr/previews/manifest.json', JSON.stringify({ previews: [
      { path: '.propr/previews/hosted-storage.png', title: 'Hosted storage with real session', description: 'Connect PR202 frontend reading disposable instance storage over HTTPS with host-only SameSite=Lax session; cleanup defaults OFF / 24h.' },
      { path: '.propr/previews/hosted-confirmation.png', title: 'Explicit cleanup confirmation', description: 'Real isolated API preview and confirmation; no customer data.' },
      { path: '.propr/previews/unsupported-origin.png', title: 'Unsupported origin fails closed', description: 'Preview origin cannot access storage; usage remains unknown and controls disabled.' },
    ], toolSuggestions: [] }));
  } else t.diagnostic('Set CONNECT_STORAGE_FRONTEND_DIST to the built routing#202 frontend to run UI acceptance. HTTPS session/API browser acceptance ran.');
  await new Promise<void>((resolve, reject) => store.clear(error => error ? reject(error) : resolve()));
  await page.goto(`${environment.PROPR_CONNECT_URL}/fixture`);
  assert.equal((await request(`${base}/policy`)).status, 401, 'revoked session cannot read storage');
});
