import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parse } from 'dotenv';
import { buildGithubAppManifest, GITHUB_APP_PERMISSIONS, SUPPORTED_WEBHOOK_EVENTS } from '@propr/shared';
import { createGithubApp, createGithubAppCommand, startGithubAppListener, registrationPage, registrationUrl, writeGithubAppConfig, writeGithubAppManifest, isPrivateGithubAppUrl, type GithubAppIo } from './githubAppCommands.js';
import { buildSequentialPrompts } from './setup/sequential.js';
import { buildSetupPrompts, SetupBridge } from '../tui/SetupApp.js';
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
function harness(root: string, options: { noBrowser?: boolean; wrongState?: boolean; spoofInstallation?: boolean; conversionStatus?: number; discover?: boolean; secretOverride?: string; forwarded?: boolean; browserCannotReachLoopback?: boolean } = {}) {
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
        if (!options.browserCannotReachLoopback) await fetch(callback);
      } else if (!options.discover && !options.browserCannotReachLoopback) {
        await fetch(`${manifest.setup_url}&installation_id=${options.spoofInstallation ? 666 : 789}`);
      }
    },
    async ask(message) {
      if (message.includes('creation') || message.includes('Waiting for GitHub')) {
        const registrationFile = readdirSync(root).find(name => name.endsWith('.html'));
        if (registrationFile) readPage(readFileSync(join(root, registrationFile), 'utf8'));
        const callback = `${manifest.redirect_url}?code=one-time-code&state=${options.wrongState ? 'wrong' : state}`;
        if (options.forwarded) {
          assert.equal((await fetch(callback)).status, 200);
          assert.equal((await fetch(callback)).status, 400, 'HTTP replays remain rejected');
        }
        return callback;
      }
      const callback = `${manifest.setup_url}&installation_id=${options.spoofInstallation ? 666 : 789}`;
      if (options.forwarded) {
        assert.equal((await fetch(callback)).status, 200);
        assert.equal((await fetch(callback)).status, 400, 'HTTP replays remain rejected');
      }
      return options.discover ? '' : callback;
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
  assert.equal(manifest.name, 'ProPR-propr-example-com');
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

test('default App names are sanitized and truncated, and explicit names enforce GitHub length', () => {
  const manifest = buildGithubAppManifest({ publicUrl: `https://${'long.host.'.repeat(6)}example.com:8443` });
  assert.match(manifest.name, /^[a-zA-Z0-9-]+$/);
  assert.ok(manifest.name.length <= 34);
  assert.throws(() => buildGithubAppManifest({ publicUrl, name: 'x'.repeat(35) }), /34 characters/);
  assert.equal(buildGithubAppManifest({ publicUrl, name: 'My custom App' }).name, 'My custom App');
});

test('browser flow writes usable credentials, backs up env, removes stale Connect/duplicate keys, and never logs secrets', async t => {
  const root = sandbox(t);
  const original = '# retained\nOTHER=value\nPROPR_GH_RELAY_TOKEN=relay-secret\nPROPR_ROUTING_URL=wss://example.com\nPROPR_WEB_AUTH_MODE=connect\nGH_AUTH_MODE=relay\nGH_APP_ID=111\nGH_APP_ID=222\nGH_PRIVATE_KEY_PATH=/old/key\n';
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
  assert.equal(env.PROPR_WEB_AUTH_MODE, undefined);
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

test('browser flow falls back to pasted user redirects without loopback delivery', async t => {
  const root = sandbox(t);
  const h = harness(root, { browserCannotReachLoopback: true });
  const result = await createGithubApp({ root, publicUrl }, h);
  assert.equal(parse(readFileSync(result.envPath)).GH_INSTALLATION_ID, '789');
  assert.equal(h.getManifest().hook_attributes.url, `${publicUrl}/webhook`, 'GitHub server webhooks remain public');
  assert.match(h.lines.join('\n'), /Opening GitHub/);
  assert.ok(!h.requests.some(request => request.path === '/app/installations'), 'the pasted installation ID is used without discovery');
});

test('browser flow uses a pasted installation redirect when discovery would be ambiguous', async t => {
  const root = sandbox(t);
  const h = harness(root, { browserCannotReachLoopback: true });
  let discoveries = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname !== '/app/installations') return h.fetcher(input, init);
    discoveries += 1;
    return Response.json([installation, { ...installation, id: 790 }]);
  };
  const result = await createGithubApp({ root, publicUrl }, { ...h, fetcher });
  assert.equal(parse(readFileSync(result.envPath)).GH_INSTALLATION_ID, '789');
  assert.equal(discoveries, 0);
  assert.ok(h.requests.some(request => request.path === '/app/installations/789'), 'the pasted ID is still verified');
});

test('a paste delivered to a pending listener wait returns the pasted value to both consumers', async () => {
  const listener = await startGithubAppListener('state');
  const controller = new AbortController();
  try {
    for (const kind of ['created', 'installed'] as const) {
      const callback = `${listener.base}/${kind}?state=state&${kind === 'created' ? 'code=x' : 'installation_id=42'}`;
      const waiting = listener.wait(kind, 60_000, controller.signal);
      assert.equal(listener.fromPaste(callback, kind), kind === 'created' ? 'x' : '42');
      assert.equal(await waiting, kind === 'created' ? 'x' : '42');
      assert.throws(() => listener.fromPaste(callback, kind), /already been used/);
    }
  } finally { controller.abort(); listener.close(); }
});

// Runs the real flow with production callback deadlines (55 and 5 minutes) in a
// child process: an abandoned listener wait must not keep the CLI alive.
const exitFixture = `
const { generateKeyPairSync } = await import('node:crypto');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { createGithubApp } = await import(process.env.GITHUB_APP_MODULE);
const { privateKey: pem } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const installation = JSON.parse(process.env.GITHUB_APP_INSTALLATION);
const root = mkdtempSync(join(tmpdir(), 'propr-github-app-exit-'));
let registration;
const io = {
  log() {},
  async open(url) { if (url.includes('/register/')) registration = new URL(url); },
  async ask(message) {
    if (!message.includes('Waiting for GitHub')) return '';
    if (process.env.GITHUB_APP_SCENARIO === 'invalid-paste') return 'not a redirect url';
    return registration.origin + '/created?code=one-time-code&state=' + registration.pathname.split('/').pop();
  },
};
const fetcher = async input => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith('/app-manifests/')) return Response.json({ id: installation.app_id, slug: 'propr-test', pem, webhook_secret: 'w', client_id: 'c', client_secret: 's' }, { status: 201 });
  if (path.endsWith('/access_tokens')) return Response.json({ token: 't' });
  return Response.json(path === '/app/installations' ? [installation] : installation);
};
try {
  await createGithubApp({ root, publicUrl: 'https://propr.example.com' }, { io, fetcher });
  console.log('completed');
} catch (error) { console.log('rejected: ' + error.message); }
finally { rmSync(root, { recursive: true, force: true }); }
`;
function runExitFixture(scenario: string): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', exitFixture], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', GITHUB_APP_SCENARIO: scenario, GITHUB_APP_INSTALLATION: JSON.stringify(installation), GITHUB_APP_MODULE: new URL('./githubAppCommands.ts', import.meta.url).href },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    // Far below the five-minute installation deadline, generous for a cold tsx start.
    const hung = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (status, signal) => { clearTimeout(hung); accept({ status, signal, stdout, stderr }); });
  });
}
for (const [scenario, outcome] of [
  ['enter-to-discover', /^completed\n$/],
  ['invalid-paste', /^rejected: Paste the complete GitHub redirect URL\.\n$/],
] as const) test(`the process exits promptly after ${scenario} without waiting for callback deadlines`, { timeout: 90_000 }, async () => {
  const result = await runExitFixture(scenario);
  assert.equal(result.signal, null, `the child was still alive after the flow settled: ${result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, outcome);
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
  const envSnippet = readFileSync(result.envSnippetPath, 'utf8');
  assert.ok(!envSnippet.includes('do-not-write-this'));
  assert.match(envSnippet, /Remove .*PROPR_WEB_AUTH_MODE/);
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

for (const discover of [false, true]) test(`forwarded SSH callbacks share the paste result (discover=${discover})`, async t => {
  const root = sandbox(t);
  const h = harness(root, { forwarded: true, discover });
  const result = await createGithubApp({ root, publicUrl, browser: false }, h);
  assert.equal(parse(readFileSync(result.envPath)).GH_INSTALLATION_ID, '789');
  assert.equal(h.requests.filter(r => r.path.startsWith('/app-manifests/')).length, 1);
  assert.ok(!h.requests.some(r => r.path === '/app/installations'));
});

test('paste consumption retains replay protection for both callbacks', async () => {
  const listener = await startGithubAppListener('state');
  try {
    for (const kind of ['created', 'installed'] as const) {
      const callback = `${listener.base}/${kind}?state=state&${kind === 'created' ? 'code=x' : 'installation_id=1'}`;
      assert.equal((await fetch(callback)).status, 200);
      assert.equal(listener.fromPaste(callback, kind), kind === 'created' ? 'x' : '1');
      assert.throws(() => listener.fromPaste(callback, kind), /already been used/);
      assert.equal((await fetch(callback)).status, 400);
    }
  } finally { listener.close(); }
});

for (const stage of ['conversion', 'hook', 'discovery', 'verification', 'verification-body'] as const) {
  test(`cancellation during ${stage} preserves credentials without committing configuration`, async t => {
    const root = sandbox(t);
    const original = 'GH_INSTALLATION_ID=1\nPROPR_GH_RELAY_TOKEN=x\n';
    writeFileSync(join(root, '.env'), original);
    const bridge = new SetupBridge();
    const h = harness(root, { discover: stage === 'discovery', secretOverride: 'override-secret' });
    const fetcher: typeof fetch = async (...args) => {
      const response = await h.fetcher(...args);
      const path = new URL(String(args[0])).pathname;
      const target = stage === 'conversion' ? path.startsWith('/app-manifests/')
        : stage === 'hook' ? path === '/app/hook/config'
        : stage === 'discovery' ? path === '/app/installations'
        : path === '/app/installations/789';
      if (target) {
        const cancel = () => {
          bridge.cancel();
          assert.equal(args[1]?.signal?.aborted, true, 'request signal includes wizard cancellation');
        };
        if (stage === 'verification-body') {
          const json = response.json.bind(response);
          t.mock.method(response, 'json', async () => { const body = await json(); cancel(); return body; });
        } else cancel();
      }
      return response; // Also exercise transports that complete despite cancellation.
    };
    await assert.rejects(createGithubApp({
      root, publicUrl, force: true, browser: false,
      ...(stage === 'hook' ? { webhookSecret: 'override-secret' } : {}),
    }, { ...h, fetcher, signal: bridge.abortController.signal }), /cancelled/);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), original);
    assert.deepEqual(readdirSync(root).sort(), ['.env', `github-app-${credentials.id}-recovery.json`]);
    const saved = JSON.parse(readFileSync(join(root, `github-app-${credentials.id}-recovery.json`), 'utf8'));
    assert.equal(saved.pem, pem);
    assert.equal(saved.webhook_secret, stage === 'hook' ? 'override-secret' : credentials.webhook_secret);
    assert.equal(h.requests.length, stage === 'conversion' ? 1 : 2, 'no subsequent API work after cancellation');
  });
}

for (const stage of ['creation', 'installation']) test(`cancellation aborts the ${stage} paste prompt`, async t => {
  const root = sandbox(t);
  const h = harness(root);
  const controller = new AbortController();
  const ask: GithubAppIo['ask'] = async (message, signal) => {
    if (message.includes(stage)) {
      const answer = new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      controller.abort();
      return answer;
    }
    return h.io.ask(message, signal);
  };
  await assert.rejects(createGithubApp({ root, publicUrl, browser: false }, {
    ...h, io: { ...h.io, ask }, signal: controller.signal,
  }), /cancelled/);
  assert.ok(!existsSync(join(root, '.env')));
  assert.equal(h.requests.length, stage === 'creation' ? 0 : 1, 'cancellation must not start installation discovery');
  assert.equal(readdirSync(root).some(name => name.includes('recovery')), stage === 'installation');
});

for (const stage of ['registration', 'installation']) test(`cancellation while opening ${stage} stops subsequent work`, async t => {
  const root = sandbox(t);
  const h = harness(root);
  const controller = new AbortController();
  const open = async (url: string) => {
    await h.io.open(url);
    if (url.includes('/register/') === (stage === 'registration')) controller.abort();
  };
  await assert.rejects(createGithubApp({ root, publicUrl }, { ...h, io: { ...h.io, open }, signal: controller.signal }), /cancelled/);
  assert.ok(!existsSync(join(root, '.env')));
  assert.equal(h.requests.length, stage === 'registration' ? 0 : 1);
});

for (const renderer of ['sequential', 'Ink']) test(`${renderer} confirms relay replacement and completes through the real credential guard`, async t => {
  const root = sandbox(t);
  const original = 'GH_INSTALLATION_ID=1\nPROPR_GH_RELAY_TOKEN=x\n';
  writeFileSync(join(root, '.env'), original);
  const h = harness(root);
  let backupPath: string | undefined;
  const createApp: typeof createGithubApp = async (options, dependencies) => {
    assert.equal(options.force, true);
    const result = await createGithubApp(options, { ...dependencies, ...h });
    backupPath = result.backupPath;
    return result;
  };
  const bridge = new SetupBridge();
  const inkAnswers = ['app', 'create', true, publicUrl, ''];
  bridge.subscribe(event => {
    if (event.type === 'prompt') {
      if (event.prompt.kind === 'confirm') {
        assert.match(event.prompt.detail!, /timestamped .env backup/);
        assert.equal(event.prompt.defaultValue, false);
      }
      bridge.resolve(event.prompt.id, inkAnswers.shift());
    }
  });
  const answers = ['3', '1', 'y', publicUrl, ''];
  const lines: string[] = [];
  const hooks = renderer === 'Ink' ? buildSetupPrompts(bridge, createApp)
    : buildSequentialPrompts({ print: line => lines.push(line ?? ''), ask: async () => answers.shift()!, close() {} }, undefined, createApp);
  assert.deepEqual(await hooks.configureGithubAuth!({ current: { mode: 'relay', warnings: [] }, rootDir: root }), { keep: true });
  if (renderer === 'sequential') assert.match(lines.join('\n'), /timestamped .env backup/);
  assert.equal(readFileSync(backupPath!, 'utf8'), original);
  const env = parse(readFileSync(join(root, '.env')));
  assert.equal(env.GH_AUTH_MODE, 'app');
  assert.equal(env.GH_INSTALLATION_ID, '789');
  assert.equal(env.PROPR_GH_RELAY_TOKEN, undefined);
});

test('an already cancelled flow or config writer cannot mutate files', async t => {
  const root = sandbox(t);
  const h = harness(root);
  const signal = AbortSignal.abort();
  await assert.rejects(createGithubApp({ root, publicUrl }, { ...h, signal }), /cancelled/);
  assert.throws(() => writeGithubAppConfig(root, credentials, '789', { publicUrl }, '', signal), /cancelled/);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(h.requests.length, 0);
});

test('cancellation during post-commit checks stops later requests and reports cancellation', async t => {
  const root = sandbox(t);
  const h = harness(root);
  const controller = new AbortController();
  let verifications = 0;
  const fetcher: typeof fetch = async (...args) => {
    const response = await h.fetcher(...args);
    if (String(args[0]).endsWith('/app/installations/789') && ++verifications === 2) controller.abort();
    return response;
  };
  await assert.rejects(createGithubApp({ root, publicUrl }, { ...h, fetcher, signal: controller.signal }), /cancelled/);
  assert.ok(existsSync(join(root, '.env')), 'configuration committed before cancellation is retained');
  assert.ok(!h.requests.some(r => r.path.endsWith('/access_tokens')));
});

test('cancellation aborts an in-flight API request and preserves recovery credentials', async t => {
  const root = sandbox(t);
  const h = harness(root);
  const controller = new AbortController();
  const fetcher: typeof fetch = async (...args) => {
    if (!String(args[0]).endsWith('/app/installations/789')) return h.fetcher(...args);
    const pending = new Promise<Response>((_, reject) => {
      args[1]!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    controller.abort();
    return pending;
  };
  await assert.rejects(createGithubApp({ root, publicUrl }, { ...h, fetcher, signal: controller.signal }), /cancelled/);
  assert.ok(!existsSync(join(root, '.env')));
  assert.ok(readdirSync(root).some(name => name.includes('recovery')));
});

test('an Ink installation prompt deadline still falls back to discovery', async t => {
  const root = sandbox(t);
  const h = harness(root);
  const bridge = new SetupBridge();
  const io: GithubAppIo = { ...h.io, ask: (message, signal) => message.includes('creation')
    ? h.io.ask(message, signal) : bridge.input({ title: message, mask: true }, signal) };
  const result = await createGithubApp({ root, publicUrl, browser: false }, { ...h, io, installationTimeoutMs: 1 });
  assert.equal(parse(readFileSync(result.envPath)).GH_INSTALLATION_ID, '789');
  assert.ok(h.requests.some(r => r.path === '/app/installations'));
});

for (const command of ['create', 'manifest']) {
  for (const [flag, value, message] of [
    ['--public-url', 'https://', /absolute HTTP\(S\) public URL/],
    ['--public-url', 'ftp://example.com', /HTTP\(S\) URL without credentials/],
    ['--webhook-url', 'https://user:secret@example.com', /HTTP\(S\) URL without credentials/],
  ] as const) test(`${command} reports actionable ${flag} validation before side effects: ${value}`, async t => {
    const root = sandbox(t);
    const h = harness(root);
    const errors: string[] = [];
    const previousExitCode = process.exitCode;
    t.after(() => { process.exitCode = previousExitCode; });
    t.mock.method(console, 'error', (line: string) => errors.push(line));
    await createGithubAppCommand(h).parseAsync([command, '--root', root, '--public-url', publicUrl, flag, value], { from: 'user' });
    assert.equal(process.exitCode, 1);
    assert.match(errors.join('\n'), message);
    assert.ok(!errors.join('\n').includes('secret'));
    assert.deepEqual(readdirSync(root), []);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.lines, []);
  });
}

test('commands reject an overlong App name before browser, network, or file side effects', async t => {
  const root = sandbox(t);
  const h = harness(root);
  const errors: string[] = [];
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  t.mock.method(console, 'error', (line: string) => errors.push(line));
  await createGithubAppCommand(h).parseAsync(['create', '--root', root, '--public-url', publicUrl, '--name', 'x'.repeat(35)], { from: 'user' });
  assert.equal(process.exitCode, 1);
  assert.match(errors.join('\n'), /34 characters/);
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.lines, []);
});

test('SSH instructions specify the required loopback host and identical forwarding ports', async t => {
  const root = sandbox(t);
  const h = harness(root);
  await createGithubApp({ root, publicUrl, browser: false }, h);
  const port = new URL(h.getManifest().redirect_url!).port;
  const output = h.lines.join('\n');
  assert.ok(output.includes(`same local and remote loopback port (${port})`));
  assert.ok(output.includes(`open exactly http://127.0.0.1:${port}/register/`));
  assert.match(output, /Use 127\.0\.0\.1, not localhost; do not change the port/);
});

for (const stage of ['installation', 'token'] as const) {
  for (const failure of ['network', 'timeout', 'body', 401, 403, 404, 429, 503, 'foreign'] as const) {
    if (stage === 'token' && failure === 'foreign') continue;
    test(`verification ${stage} ${failure} is classified consistently by check and creation`, async t => {
      const root = sandbox(t);
      const h = harness(root);
      const { checkGithubApp, githubAppCheckFailure } = await import('./githubAppApi.js');
      const expected = [401, 403, 404, 'foreign'].includes(failure) ? 'fail' : 'warn';
      const failingFetch: typeof fetch = async (...args) => {
        const isToken = String(args[0]).endsWith('/access_tokens');
        if (isToken !== (stage === 'token')) return h.fetcher(...args);
        if (failure === 'network') throw new TypeError('fetch failed: secret-token');
        if (failure === 'timeout') throw new DOMException('secret-token', 'TimeoutError');
        if (failure === 'body') return new Response('invalid JSON secret-token');
        if (failure === 'foreign') return Response.json({ ...installation, app_id: 999 });
        return Response.json({ message: 'secret-token' }, { status: failure });
      };
      await assert.rejects(checkGithubApp(credentials.id, installation.id, pem, failingFetch), error => {
        const result = githubAppCheckFailure(error);
        assert.equal(result.status, expected);
        assert.ok(!result.detail.includes('secret-token'));
        return true;
      });
      // Fail only the post-save check, after the installation was verified for saving.
      let verifications = 0;
      const fetcher: typeof fetch = async (...args) => {
        const path = new URL(String(args[0])).pathname;
        if (path === '/app/installations/789') verifications++;
        if (verifications >= 2) return failingFetch(...args);
        return h.fetcher(...args);
      };
      const result = await createGithubApp({ root, publicUrl }, { ...h, fetcher });
      assert.equal(result.checks[0].status, expected);
      assert.match(result.checks[0].detail, /Credentials saved/);
      assert.ok(!h.lines.join('\n').includes('secret-token'));
      assert.equal(parse(readFileSync(result.envPath)).GH_INSTALLATION_ID, '789');
    });
  }
}

test('ordinary checks skip GitHub App requests; explicit verification reports requests and unavailable host keys', async t => {
  const root = sandbox(t);
  writeFileSync(join(root, 'key.pem'), pem);
  const env: Record<string, string> = {
    GH_AUTH_MODE: 'app', GH_APP_ID: String(credentials.id), GH_INSTALLATION_ID: '789',
    HOST_GH_PRIVATE_KEY: join(root, 'key.pem'), PROPR_DEMO_MODE: 'false',
    GITHUB_EVENT_INTAKE_MODE: 'direct_webhook', GH_WEBHOOK_SECRET: 'test-secret',
  };
  writeFileSync(join(root, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  const savedEnv = { ...process.env };
  t.after(() => { process.env = savedEnv; });
  for (const key of Object.keys(process.env)) {
    if (/^(GH_|PROPR_GH_RELAY_|PROPR_ROUTING_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, env);
  const { runChecks } = await import('./checkCommands.js');
  const requests: string[] = [];
  let status = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));
    if (!status) throw new TypeError('fetch failed');
    return Response.json({}, { status });
  });
  const options = { root, skipRemoteImageCheck: true, agents: ['not-selected'] };
  const normal = await runChecks(options);
  assert.equal(normal.results.find(r => r.name === 'GitHub App key')?.status, 'ok');
  assert.equal(normal.results.find(r => r.name === 'GitHub App API'), undefined);
  assert.deepEqual(requests, [], 'bare propr and propr check must not mint a token or contact GitHub');
  for (status of [0, 401, 404]) {
    const verified = await runChecks({ ...options, verify: true });
    assert.equal(verified.results.find(r => r.name === 'GitHub App API')?.status, status ? 'fail' : 'warn');
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every(url => url === 'https://api.github.com/app/installations/789'));

  delete process.env.HOST_GH_PRIVATE_KEY;
  process.env.GH_PRIVATE_KEY_PATH = '/usr/src/app/data/key.pem';
  delete env.HOST_GH_PRIVATE_KEY;
  Object.assign(env, { GH_PRIVATE_KEY_PATH: '/usr/src/app/data/key.pem' });
  writeFileSync(join(root, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  const containerKeyOnly = await runChecks({ ...options, verify: true });
  const skipped = containerKeyOnly.results.find(r => r.name === 'GitHub App API');
  assert.equal(skipped?.status, 'warn');
  assert.match(skipped?.detail ?? '', /verification skipped.*host-readable private key/i);
  assert.equal(requests.length, 3, 'a container-only key path must not trigger a GitHub request');
});
