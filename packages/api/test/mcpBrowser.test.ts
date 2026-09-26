import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import express from 'express';
import session from 'express-session';
import { chromium } from 'playwright';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider, type McpGrant } from '../mcp/oauth.js';
import { mountMcpBrowser } from '../mcp/browser.js';
import { configureDemoMode } from '../demoMode.js';
import { mountMcp } from '../mcp/server.js';
import { configureApiProxyTrust } from '../requestRateLimits.js';

after(async () => closeConnection());

test('authorize limits GET and POST before client lookup and respects explicit proxy trust', async t => {
  const environment = {
    MCP_ENABLED: 'true', MCP_PUBLIC_ORIGIN: 'https://instance.example', MCP_INSTANCE_ID: 'test-instance',
    MCP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MCP_CONNECT_TRUST: 'false',
    PROPR_AUTH_RATE_LIMIT_MAX: '3', PROPR_AUTH_RATE_LIMIT_WINDOW_MS: '60000',
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  configureDemoMode(false);
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => db.destroy());
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary()); await up(db);
  const oauth = new McpOAuthProvider(new McpStore(db, Buffer.from(environment.MCP_ENCRYPTION_KEY, 'base64')), {
    origin: environment.MCP_PUBLIC_ORIGIN, resource: `${environment.MCP_PUBLIC_ORIGIN}/api/mcp`,
    instanceId: environment.MCP_INSTANCE_ID, encryptionKey: Buffer.from(environment.MCP_ENCRYPTION_KEY, 'base64'),
  });
  const client = await oauth.clientsStore.registerClient!({ token_endpoint_auth_method: 'none',
    redirect_uris: ['http://127.0.0.1:4321/callback'], grant_types: ['authorization_code'], response_types: ['code'] });
  const lookup = t.mock.method(McpStore.prototype, 'get');
  for (const trusted of [false, true]) {
    const app = express();
    configureApiProxyTrust(app, trusted ? { PROPR_TRUSTED_PROXY_PEERS: 'loopback' } : {});
    mountMcp(app, { db, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never });
    const server = createHttpServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0],
      response_type: 'code', code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
      code_challenge_method: 'S256', scope: 'read', resource: `${environment.MCP_PUBLIC_ORIGIN}/api/mcp` });
    const request = (method: string, forwardedFor = trusted ? '192.0.2.1' : '') => fetch(`${origin}/authorize${method === 'POST' ? '' : `?${params}`}`, {
      method, redirect: 'manual', headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {},
      ...(method === 'POST' ? { body: params } : {}),
    });
    try {
      const beforePreflight = lookup.mock.callCount();
      assert.equal((await request('OPTIONS')).status, 405);
      assert.equal(lookup.mock.callCount(), beforePreflight, 'preflight must not perform lookup work');
      for (const method of ['GET', 'POST']) {
        const response = await request(method);
        assert.equal(response.status, 302);
        assert.match(response.headers.get('location') || '', /^https:\/\/instance\.example\/mcp\/consent\?request=/);
      }
      params.set('redirect_uri', 'http://127.0.0.1:4322/callback');
      assert.equal((await request('GET')).status, 400, 'loopback redirect ports still require an exact match');
      assert.ok(lookup.mock.callCount() > beforePreflight);
      const beforeExcess = lookup.mock.callCount();
      params.set('client_id', 'https://client.example/metadata.json');
      for (const method of ['GET', 'POST']) {
        const response = await request(method);
        assert.equal(response.status, 429);
        assert.ok(Number(response.headers.get('retry-after')) > 0);
        assert.equal((await response.json()).code, 'RATE_LIMIT_EXCEEDED');
      }
      assert.equal(lookup.mock.callCount(), beforeExcess, 'excess requests must never reach client lookup');
      params.set('client_id', client.client_id);
      params.set('redirect_uri', client.redirect_uris[0]);
      assert.equal((await request('GET', '192.0.2.2')).status, trusted ? 302 : 429);
      if (!trusted) assert.equal(lookup.mock.callCount(), beforeExcess, 'spoofed forwarding headers cannot bypass the limiter');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('real consent and connected-app routes work at desktop/mobile widths and enforce CSRF and revocation', async t => {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
  assert.ok(existsSync(executablePath), 'Install Chromium with npx playwright install --with-deps chromium or set CHROMIUM_PATH');
  configureDemoMode(false);
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary()); await up(db);
  await db.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  // Exercise real TLS and Secure cookies with an ephemeral, local-only certificate.
  const tlsDirectory = await mkdtemp(join(tmpdir(), 'propr-mcp-browser-tls-'));
  t.after(() => rm(tlsDirectory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(tlsDirectory, 'key.pem'), '-out', join(tlsDirectory, 'cert.pem')], { stdio: 'ignore' });
  const app = express();
  app.use(session({ secret: randomBytes(32).toString('hex'), resave: false, saveUninitialized: false,
    cookie: { secure: true, httpOnly: true, sameSite: 'lax' } }));
  app.use((req, _res, next) => { req.user = { id: '123', username: 'demo-developer', login: 'demo-developer', displayName: 'Demo developer', email: null, avatarUrl: null, accessToken: 'fixture-only' }; req.isAuthenticated = (() => true) as never; next(); });
  const server = createServer({ key: await readFile(join(tlsDirectory, 'key.pem')), cert: await readFile(join(tlsDirectory, 'cert.pem')) }, app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oauth = new McpOAuthProvider(new McpStore(db, randomBytes(32)), { origin, resource: `${origin}/api/mcp`, instanceId: 'development-instance', encryptionKey: randomBytes(32) });
  let accessibleRepositories = ['acme/web-app', 'acme/api-service'];
  mountMcpBrowser(app, oauth, { accessibleRepositories: async () => accessibleRepositories });
  const client = await oauth.clientsStore.registerClient!({ client_name: 'Development chat client', token_endpoint_auth_method: 'none', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const verifier = randomBytes(32).toString('base64url');
  const authorize = async (scopes = ['read', 'plan', 'execute'], clientName = client.client_name) => {
    let consent = '';
    await oauth.authorize({ ...client, client_name: clientName }, { redirectUri: client.redirect_uris[0], resource: new URL(`${origin}/api/mcp`), codeChallenge: createHash('sha256').update(verifier).digest('base64url'), scopes }, { redirect: (url: string) => { consent = url; } } as never);
    return consent;
  };
  const consent = await authorize();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const response = await page.goto(consent);
    assert.equal(response?.headers()['cache-control'], 'no-store');
    const policy = response?.headers()['content-security-policy'] || '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    assert.ok(nonce);
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'; base-uri 'none'/);
    assert.ok(policy.includes(`form-action 'self' https://client.example`));
    assert.ok(policy.includes(`style-src 'nonce-${nonce}'`));
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
    assert.equal(await page.locator('script').evaluate(element => (element as HTMLScriptElement).nonce), nonce);
    assert.equal(await page.locator('style').evaluate(element => (element as HTMLStyleElement).nonce), nonce);
    const sessionCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'connect.sid');
    assert.ok(sessionCookie, 'HTTPS consent must establish a browser session');
    assert.equal(sessionCookie.secure, true);
    assert.equal(sessionCookie.httpOnly, true);
    assert.equal(sessionCookie.sameSite, 'Lax');
    assert.equal(await page.getByRole('heading', { name: 'Connect an app' }).count(), 1);
    const rejected = await context.request.post(`${origin}/mcp/consent`, { form: { csrf: 'wrong', request: new URL(consent).searchParams.get('request')!, decision: 'approve', repositories: 'acme/web-app' }, headers: { Origin: origin } });
    assert.equal(rejected.status(), 403);
    assert.equal(await page.getByLabel('read (required)', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('plan', { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel('execute', { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel('acme/web-app').isChecked(), false);
    assert.equal(await page.getByLabel('acme/api-service').isChecked(), false);
    // A forged form cannot add unrequested permissions, even with valid CSRF.
    const csrf = await page.locator('input[name=csrf]').inputValue();
    const escalation = await context.request.post(`${origin}/mcp/consent`, { form: {
      csrf, request: new URL(consent).searchParams.get('request')!, decision: 'approve', repositories: 'acme/web-app', scopes: 'merge'
    }, headers: { Origin: origin } });
    assert.equal(escalation.status(), 400);
    const forgedForm = { csrf, request: new URL(consent).searchParams.get('request')!, decision: 'approve', repositories: 'acme/web-app', scopes: 'read' };
    assert.equal((await context.request.post(`${origin}/mcp/consent`, { form: forgedForm, headers: { Origin: 'https://attacker.example' } })).status(), 403);
    assert.equal((await context.request.post(`${origin}/mcp/consent`, { form: { ...forgedForm, scopes: 'plan' }, headers: { Origin: origin } })).status(), 400);
    assert.equal((await context.request.post(`${origin}/mcp/consent`, { form: { ...forgedForm, repositories: 'acme/private' }, headers: { Origin: origin } })).status(), 400);

    const permissions = page.getByRole('group', { name: 'Permissions', exact: true });
    const repositories = page.getByRole('group', { name: 'Repositories', exact: true });
    const assertCounts = async (scopes: number, repos: number) => {
      assert.equal(await permissions.getByRole('status').innerText(), `${scopes} of 3 permissions selected`);
      assert.equal(await repositories.getByRole('status').innerText(), `${repos} of 2 repositories selected`);
      assert.equal(await page.getByLabel('read (required)', { exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel('read (required)', { exact: true }).isDisabled(), true);
    };
    let consentPosts = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/mcp/consent') consentPosts++; });
    const capture = process.env.MCP_CAPTURE_PREVIEWS === 'true';
    if (capture) await mkdir('.propr/previews', { recursive: true });
    const exerciseSelections = async (device: 'desktop' | 'mobile') => {
      await page.setViewportSize(device === 'desktop' ? { width: 1200, height: 1000 } : { width: 390, height: 844 });
      await assertCounts(device === 'desktop' ? 1 : 2, device === 'desktop' ? 0 : 1);
      const selectPermissions = permissions.getByRole('button', { name: 'Select all permissions' });
      const clearPermissions = permissions.getByRole('button', { name: 'Clear permissions' });
      const selectRepositories = repositories.getByRole('button', { name: 'Select all repositories' });
      const clearRepositories = repositories.getByRole('button', { name: 'Clear repositories' });
      // Tab through the real controls; exercise both Enter and Space activation.
      if (device === 'desktop') {
        await page.keyboard.press('Tab');
        assert.equal(await selectPermissions.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Enter');
      } else await selectPermissions.click();
      await assertCounts(3, device === 'desktop' ? 0 : 1);
      assert.deepEqual(await permissions.getByRole('checkbox').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value)), ['read', 'plan', 'execute']);
      if (device === 'desktop') {
        await page.keyboard.press('Tab');
        assert.equal(await clearPermissions.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Space');
      } else await clearPermissions.click();
      await assertCounts(1, device === 'desktop' ? 0 : 1);
      if (device === 'desktop') {
        await page.keyboard.press('Tab');
        assert.equal(await page.getByLabel('plan', { exact: true }).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Space');
        await page.keyboard.press('Tab'); // execute remains unselected
        await page.keyboard.press('Tab');
        assert.equal(await selectRepositories.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Space');
      } else {
        await page.getByLabel('plan', { exact: true }).check();
        await selectRepositories.click();
      }
      await assertCounts(2, 2);
      if (device === 'desktop') {
        await page.keyboard.press('Tab');
        assert.equal(await clearRepositories.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Enter');
      } else await clearRepositories.click();
      await assertCounts(2, 0);
      if (device === 'desktop') {
        await page.keyboard.press('Tab');
        assert.equal(await page.getByLabel('acme/web-app').evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Space');
      } else await page.getByLabel('acme/web-app').check();
      await assertCounts(2, 1);
      // Individual changes still work after bulk selection in each group.
      await selectPermissions.click();
      await page.getByLabel('execute', { exact: true }).uncheck();
      await selectRepositories.click();
      await page.getByLabel('acme/api-service').uncheck();
      await assertCounts(2, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(page.url(), consent);
      assert.equal(consentPosts, 0, 'bulk and individual selection must never submit consent');
      assert.equal((await db('mcp_records').where({ kind: 'grant' })).length, 0);
      if (capture) await page.screenshot({ path: `.propr/previews/mcp-consent-${device}.png`, fullPage: true });
    };
    await exerciseSelections('desktop');
    await exerciseSelections('mobile');
    // Repositories are reauthorized at submission, even if they were originally offered.
    accessibleRepositories = ['acme/api-service'];
    assert.equal((await context.request.post(`${origin}/mcp/consent`, { form: forgedForm, headers: { Origin: origin } })).status(), 400);
    accessibleRepositories = ['acme/web-app', 'acme/api-service'];
    await page.route('https://client.example/callback*', route => route.fulfill({ body: 'OAuth test callback' }));
    await page.getByRole('button', { name: 'Allow selected access' }).click();
    await page.waitForURL('https://client.example/callback*', { timeout: 3000 }).catch(async () => { throw new Error(`Consent navigation failed: ${await page.locator('body').innerText()}`); });
    const code = new URL(page.url()).searchParams.get('code')!;
    const token = await oauth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], new URL(`${origin}/api/mcp`));
    assert.equal(consentPosts, 1);
    assert.deepEqual(token.scope?.split(' ').sort(), ['plan', 'read']);
    const access = await oauth.verifyAccessToken(token.access_token);
    assert.deepEqual([...access.scopes].sort(), ['plan', 'read']);
    const grant = await oauth.store.get<McpGrant>('grant', access.extra.grantId);
    assert.deepEqual(grant?.scopes.slice().sort(), ['plan', 'read']);
    assert.deepEqual(grant?.repositories, ['acme/web-app']);
    await page.goto(`${origin}/mcp/apps`);
    assert.equal(await page.getByRole('heading', { name: 'Development chat client' }).count(), 1);

    await page.getByRole('button', { name: 'Revoke access' }).click();
    await page.getByText('No connected apps.').waitFor();
    await assert.rejects(oauth.verifyAccessToken(token.access_token));

    // Progressive enhancement: manual selection and approval still work without JavaScript.
    const noScriptContext = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(await authorize());
    assert.equal(await noScriptPage.getByRole('button', { name: 'Select all permissions' }).isVisible(), false);
    assert.equal(await noScriptPage.getByRole('button', { name: 'Clear repositories' }).isVisible(), false);
    await noScriptPage.getByLabel('plan', { exact: true }).check();
    await noScriptPage.getByLabel('plan', { exact: true }).uncheck();
    await noScriptPage.getByLabel('acme/api-service').check();
    await noScriptPage.route('https://client.example/callback*', route => route.fulfill({ body: 'OAuth test callback' }));
    await noScriptPage.getByRole('button', { name: 'Allow selected access' }).click();
    await noScriptPage.waitForURL('https://client.example/callback*');
    const noScriptToken = await oauth.exchangeAuthorizationCode(client, new URL(noScriptPage.url()).searchParams.get('code')!, verifier, client.redirect_uris[0], new URL(`${origin}/api/mcp`));
    const noScriptAccess = await oauth.verifyAccessToken(noScriptToken.access_token);
    assert.deepEqual(noScriptAccess.scopes, ['read']);
    assert.deepEqual((await oauth.store.get<McpGrant>('grant', noScriptAccess.extra.grantId))?.repositories, ['acme/api-service']);
    await noScriptContext.close();

    // Empty repositories and required-read-only requests have explicit, non-actionable bulk states.
    accessibleRepositories = [];
    const hostileName = 'Chat </script><img src=x onerror="window.injected=true">';
    const emptyConsent = await authorize(['read'], hostileName);
    const emptyResponse = await page.goto(emptyConsent);
    assert.notEqual(/script-src 'nonce-([^']+)'/.exec(emptyResponse?.headers()['content-security-policy'] || '')?.[1], nonce);
    assert.equal(await page.getByText(hostileName, { exact: true }).count(), 1);
    assert.equal(await page.locator('img').count(), 0, 'client metadata must remain escaped text');
    assert.equal(await page.locator('script').count(), 1);
    for (const group of [permissions, repositories]) {
      for (const button of await group.getByRole('button').all()) assert.equal(await button.isDisabled(), true);
    }
    assert.equal(await permissions.getByRole('status').innerText(), '1 of 1 permissions selected');
    assert.equal(await repositories.getByRole('status').innerText(), '0 of 0 repositories selected');
    assert.equal(await page.getByLabel('read (required)', { exact: true }).isChecked(), true);
    assert.equal(await page.getByText('This app only requests required read access.').isVisible(), true);
    assert.equal(await page.getByText('No accessible repositories are available.', { exact: false }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Allow selected access' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.waitForURL('https://client.example/callback*');
    assert.equal(new URL(page.url()).searchParams.get('error'), 'access_denied');
    assert.equal(new URL(page.url()).searchParams.has('code'), false);
    assert.equal((await db('mcp_records').where({ kind: 'grant' })).length, 2, 'denial must not create another grant');
    if (capture) await writeFile('.propr/previews/manifest.json', JSON.stringify({ previews: [
      { path: '.propr/previews/mcp-consent-desktop.png', title: 'MCP consent bulk controls', description: 'Actual consent route after bulk selection and individual changes, with separate permission/repository controls and selected counts. Fictional fixture data.' },
      { path: '.propr/previews/mcp-consent-mobile.png', title: 'Mobile MCP consent bulk controls', description: 'The same selected consent state at a 390-pixel mobile viewport.' },
    ], toolSuggestions: [] }, null, 2));
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.destroy(); }
});
