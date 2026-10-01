import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parse } from 'dotenv';
import { buildGithubAppManifest, GITHUB_APP_PERMISSIONS, SUPPORTED_WEBHOOK_EVENTS } from '@propr/shared';
import { createGithubApp, createGithubAppCommand, startGithubAppListener, registrationPage, registrationUrl, writeGithubAppManifest, isPrivateGithubAppUrl, type GithubAppIo } from './githubAppCommands.js';
import { appJwt, installationChecks, type AppCredentials } from './githubAppApi.js';

const { privateKey: pem, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const credentials: AppCredentials = { id: 123456, slug: 'propr-test', pem, webhook_secret: 'secret-webhook-test', client_id: 'client-id-test', client_secret: 'secret-oauth-test' };
const installation = { id: 789, app_id: credentials.id, permissions: GITHUB_APP_PERMISSIONS, events: [...SUPPORTED_WEBHOOK_EVENTS] };
const publicUrl = 'https://propr.example.com';
function sandbox(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'propr-github-app-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function harness(root: string, options: { noBrowser?: boolean; wrongState?: boolean; spoofInstallation?: boolean; conversionStatus?: number; discover?: boolean; secretOverride?: string } = {}) {
  const lines: string[] = [];
  const requests: { path: string; init?: RequestInit }[] = [];
  let manifest: ReturnType<typeof buildGithubAppManifest>;
  let state = '';
  function readPage(html: string) {
    const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    manifest = JSON.parse(unescape(/name="manifest" value="([^"]+)"/.exec(html)![1]));
    const action = unescape(/action="([^"]+)"/.exec(html)![1]);
    state = new URL(action).searchParams.get('state')!;
    return action;
  }
  const io: GithubAppIo = {
    log: line => lines.push(line),
    async open(url) {
      if (url.includes('/register/')) {
        const response = await fetch(url);
        readPage(await response.text());
        const callback = `${manifest.redirect_url}?code=one-time-code&state=${options.wrongState ? 'wrong' : state}`;
        await fetch(callback);
      } else if (!options.discover) {
        await fetch(`${manifest.setup_url}&installation_id=${options.spoofInstallation ? 666 : 789}`);
      }
    },
    async ask(message) {
      if (message.includes('creation')) {
        readPage(readFileSync(join(root, readdirSync(root).find(name => name.endsWith('.html'))!), 'utf8'));
        return `${manifest.redirect_url}?code=one-time-code&state=${options.wrongState ? 'wrong' : state}`;
      }
      return options.discover ? '' : `${manifest.setup_url}&installation_id=${options.spoofInstallation ? 666 : 789}`;
    },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, init });
    if (path.startsWith('/app-manifests/')) {
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      return Response.json(options.conversionStatus ? { error: 'secret-oauth-test' } : credentials, { status: options.conversionStatus ?? 201 });
    }
    const jwt = (init?.headers as Record<string, string>).Authorization.replace('Bearer ', '');
    const [header, body, signature] = jwt.split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${body}`).verify(publicKey, signature, 'base64url'));
    if (path === '/app/hook/config') {
      assert.equal(JSON.parse(String(init?.body)).secret, options.secretOverride);
      return Response.json({});
    }
    if (path.endsWith('/access_tokens')) return Response.json({ token: 'installation-token-secret' });
    if (path === '/app/installations') return Response.json([installation]);
    if (path.endsWith('/666')) return Response.json({ ...installation, id: 666, app_id: 999 });
    return Response.json(installation);
  };
  return { io, fetcher, lines, requests, getManifest: () => manifest };
}

test('manifest permissions snapshot and handler dispatch stay aligned', () => {
  const manifest = buildGithubAppManifest({ publicUrl });
  assert.deepEqual(manifest.default_permissions, { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', actions: 'write' });
  assert.deepEqual(manifest.default_events, [...SUPPORTED_WEBHOOK_EVENTS]);
  const handler = readFileSync(new URL('../../../core/src/webhook/webhookHandler.ts', import.meta.url), 'utf8');
  assert.match(handler, /export \{ SUPPORTED_WEBHOOK_EVENTS \} from '@propr\/shared'/);
  const cases = [...handler.matchAll(/case '([^']+)':/g)].map(match => match[1]);
  assert.deepEqual([...new Set(cases)].sort(), [...manifest.default_events].sort(), 'newly accepted webhook events must be included in the manifest');
  assert.equal(buildGithubAppManifest({ publicUrl, allowWorkflowChanges: true }).default_permissions.workflows, 'write');
  assert.equal(manifest.hook_attributes.url, `${publicUrl}/webhook`);
  assert.deepEqual(manifest.callback_urls, [`${publicUrl}/api/auth/github/callback`]);
  assert.equal(manifest.public, false);
});

test('browser flow writes usable credentials, backs up env, removes all relay/duplicate keys, and never logs secrets', async t => {
  const root = sandbox(t);
  const original = '# retained\nOTHER=value\nPROPR_GH_RELAY_TOKEN=relay-secret\nPROPR_ROUTING_URL=wss://example.com\nGH_AUTH_MODE=relay\nGH_APP_ID=111\nGH_APP_ID=222\nGH_PRIVATE_KEY_PATH=/old/key\n';
  writeFileSync(join(root, '.env'), original);
  const h = harness(root, { secretOverride: 'override-secret' });
  const result = await createGithubApp({ root, publicUrl, org: 'integry', force: true, webhookSecret: 'override-secret' }, h);
  const env = parse(readFileSync(result.envPath));
  assert.equal(env.GH_APP_ID, '123456');
  assert.equal(env.GH_INSTALLATION_ID, '789');
  assert.equal(env.HOST_GH_PRIVATE_KEY, result.keyPath);
  assert.equal(env.GH_PRIVATE_KEY_PATH, undefined);
  assert.equal(env.PROPR_GH_RELAY_TOKEN, undefined);
  assert.equal(env.PROPR_ROUTING_URL, undefined);
  assert.equal(env.GH_AUTH_MODE, 'app');
  assert.equal(env.GH_WEBHOOK_SECRET, 'override-secret');
  assert.equal(env.GH_OAUTH_CLIENT_SECRET, credentials.client_secret);
  assert.equal(env.GH_OAUTH_CALLBACK_URL, `${publicUrl}/api/auth/github/callback`);
  assert.equal(env.GITHUB_EVENT_INTAKE_MODE, 'direct_webhook');
  assert.equal(env.OTHER, 'value');
  assert.equal(readFileSync(result.backupPath!, 'utf8'), original);
  assert.equal(readFileSync(result.keyPath, 'utf8'), pem);
  for (const path of [result.keyPath, result.envPath, result.backupPath!]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(h.requests.some(request => request.path.endsWith('/access_tokens')));
  for (const secret of [pem, credentials.client_secret, credentials.webhook_secret, 'override-secret', 'installation-token-secret', 'relay-secret']) assert.ok(!h.lines.join('\n').includes(secret));
  assert.ok(!readdirSync(root).some(name => name.includes('recovery')));
});

test('SSH paste-back and JSON command output expose only field names and paths', async t => {
  const root = sandbox(t);
  const h = harness(root, { noBrowser: true });
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  await createGithubAppCommand(h).parseAsync(['create', '--root', root, '--public-url', publicUrl, '--no-browser', '--json'], { from: 'user' });
  const json = JSON.parse(output.join(''));
  assert.ok(json.fields.includes('GH_OAUTH_CLIENT_SECRET'));
  assert.ok(existsSync(json.keyPath));
  for (const secret of [pem, credentials.client_secret, credentials.webhook_secret, 'installation-token-secret']) assert.ok(![...output, ...h.lines].join('').includes(secret));
  assert.ok(!readdirSync(root).some(name => name.endsWith('.html')));
});

test('refuses existing credentials before opening browser or changing files', async t => {
  const root = sandbox(t);
  const original = 'GH_APP_ID=123\n'; writeFileSync(join(root, '.env'), original);
  const h = harness(root);
  await assert.rejects(createGithubApp({ root, publicUrl }, h), /--force/);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), original);
  assert.deepEqual(readdirSync(root), ['.env']);
  assert.equal(h.lines.length, 0);
});

for (const browser of [true, false]) test(`state mismatch prevents conversion (browser=${browser})`, async t => {
  const root = sandbox(t); const h = harness(root, { wrongState: true });
  await assert.rejects(createGithubApp({ root, publicUrl, browser }, h), /state/);
  assert.equal(h.requests.length, 0);
  assert.ok(!existsSync(join(root, '.env')));
});

test('expired or reused conversion code gives a redacted actionable failure', async t => {
  const root = sandbox(t); const h = harness(root, { conversionStatus: 422 });
  await assert.rejects(createGithubApp({ root, publicUrl }, h), /expired or already used/);
  assert.ok(!h.lines.join('').includes(credentials.client_secret));
  assert.ok(!existsSync(join(root, '.env')));
});

test('spoofed installation cannot replace env and recovery credentials are protected', async t => {
  const root = sandbox(t); const h = harness(root, { spoofInstallation: true });
  await assert.rejects(createGithubApp({ root, publicUrl }, h), /does not belong/);
  assert.ok(!existsSync(join(root, '.env')));
  const recovery = join(root, readdirSync(root).find(name => name.includes('recovery'))!);
  assert.equal(statSync(recovery).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(recovery, 'utf8')).pem, pem);
});

test('installation timeout discovers installations and still verifies the selected ID', async t => {
  const root = sandbox(t); const h = harness(root, { discover: true });
  const result = await createGithubApp({ root, publicUrl }, { ...h, installationTimeoutMs: 1 });
  assert.equal(parse(readFileSync(result.envPath)).GH_INSTALLATION_ID, '789');
  assert.ok(h.requests.some(request => request.path === '/app/installations'));
  assert.ok(h.requests.some(request => request.path === '/app/installations/789'));
});

test('listener rejects expired/replayed state and only accepts its callback origin', async () => {
  const expired = await startGithubAppListener('state', 0);
  try { assert.throws(() => expired.receive(`${expired.base}/created?code=x&state=state`, 'created'), /expired/); }
  finally { expired.close(); }
  const listener = await startGithubAppListener('state');
  try {
    assert.throws(() => listener.receive('https://attacker.example/created?code=x&state=state', 'created'), /did not match/);
    assert.equal(listener.receive(`${listener.base}/created?code=x&state=state`, 'created'), 'x');
    assert.throws(() => listener.receive(`${listener.base}/created?code=x&state=state`, 'created'), /already been used/);
  } finally { listener.close(); }
});

test('manual manifest shares builder, protects existing output, and has no secrets', async t => {
  const root = sandbox(t);
  const result = await writeGithubAppManifest({ root, publicUrl, webhookUrl: 'https://hooks.example.com/webhook', webhookSecret: 'do-not-write-this' });
  assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')), buildGithubAppManifest({ publicUrl, webhookUrl: 'https://hooks.example.com/webhook' }));
  assert.ok(!readFileSync(result.envSnippetPath, 'utf8').includes('do-not-write-this'));
  await assert.rejects(writeGithubAppManifest({ root, publicUrl }), /--force/);
});

test('registration validates organization, escapes HTML, and detects private URLs', () => {
  assert.equal(registrationUrl('integry'), 'https://github.com/organizations/integry/settings/apps/new');
  assert.throws(() => registrationUrl('../settings'), /organization login/);
  const page = registrationPage(buildGithubAppManifest({ publicUrl, name: '"><script>alert(1)</script>' }), registrationUrl());
  assert.ok(!page.includes('<script>alert(1)</script>'));
  for (const url of ['http://127.0.0.1', 'http://localhost', 'http://192.168.1.2', 'http://172.20.1.1', 'http://[::1]']) assert.equal(isPrivateGithubAppUrl(url), true);
  assert.equal(isPrivateGithubAppUrl(publicUrl), false);
});

test('checks flag missing events, read-only Actions and absent Workflows', () => {
  const checks = installationChecks({ ...installation, permissions: { ...GITHUB_APP_PERMISSIONS, actions: 'read' }, events: ['issues'] });
  assert.match(checks.find(check => check.name === 'GitHub actions')!.detail, /CI cancellation is inert/);
  assert.match(checks.find(check => check.name === 'GitHub events')!.detail, /issue_comment/);
  assert.match(checks.find(check => check.name === 'GitHub workflows')!.detail, /pushes.*will fail/);
  const [, body] = appJwt(credentials.id, pem).split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(claims.exp - claims.iat, 600);
});

test('cancellation stops waiting for browser callbacks', async () => {
  const listener = await startGithubAppListener('state');
  const controller = new AbortController();
  try {
    const waiting = listener.wait('created', 60_000, controller.signal);
    controller.abort();
    await assert.rejects(waiting, /cancelled/);
  } finally { listener.close(); }
});

test('concurrent env edits are preserved and conversion credentials remain recoverable', async t => {
  const root = sandbox(t); const h = harness(root);
  const fetcher: typeof fetch = async (...args) => {
    const response = await h.fetcher(...args);
    if (String(args[0]).endsWith('/app/installations/789')) writeFileSync(join(root, '.env'), 'OTHER=changed\n');
    return response;
  };
  await assert.rejects(createGithubApp({ root, publicUrl }, { ...h, fetcher }), /changed during registration/);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'OTHER=changed\n');
  assert.ok(readdirSync(root).some(name => name.includes('recovery')));
});

test('token mint failure reports a failed check after safely saving credentials', async t => {
  const root = sandbox(t); const h = harness(root);
  const fetcher: typeof fetch = async (...args) => String(args[0]).endsWith('/access_tokens')
    ? Response.json({ message: credentials.client_secret }, { status: 403 }) : h.fetcher(...args);
  const result = await createGithubApp({ root, publicUrl }, { ...h, fetcher });
  assert.ok(result.checks.some(check => check.status === 'fail'));
  assert.ok(existsSync(result.envPath));
  assert.ok(!h.lines.join('').includes(credentials.client_secret));
});

test('rejects webhook overrides that env parsers would change before registration', async t => {
  const root = sandbox(t); const h = harness(root);
  for (const webhookSecret of ['"quoted"', 'secret#comment', 'two\nlines']) {
    await assert.rejects(createGithubApp({ root, publicUrl, webhookSecret }, h), /env-compatible/);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.lines.length, 0);
});
