// This harness never prints provider/application diagnostics or serializes sessions.
import { spawn, execFile as execCallback } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyRpm, OWNER_FINGERPRINT } from './rpm-signing.mjs';
import { validateDesktopRuntimeManifest } from './desktop-runtime-manifest.mjs';

export const ACCOUNT = 'propr-ultrafix';
export const REPOSITORY = `${ACCOUNT}/propr-desktop-acceptance-20260909`;
export const RESULTS = Object.freeze(['passed', 'reauthorization_required', 'account_mismatch',
  'api_compatibility_failed', 'repository_access_failed', 'app_pairing_failed', 'runtime_source_mismatch',
  'configuration_failed']);
export class SmokeFailure extends Error {
  constructor(result) { super('Live smoke stopped'); this.result = result; }
}
export function fail(result) { throw new SmokeFailure(result); }
export function resultRecord(error, dryRun = false) {
  return { schemaVersion: 1, mode: dryRun ? 'fixture' : 'live', result:
    error == null ? 'passed' : error instanceof SmokeFailure && RESULTS.includes(error.result)
      ? error.result : 'app_pairing_failed' };
}
export function assertAccount(username) {
  if (username !== ACCOUNT) fail('account_mismatch');
}
export function validateConfig(config) {
  let origin;
  try { origin = new URL(config.apiOrigin); } catch { fail('configuration_failed'); }
  // Explicit preview/staging namespace, never the production service or a tunnel.
  if (config.apiOrigin !== origin.origin || origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/' || origin.port
    || !/^(?:[a-z0-9-]+\.)*(?:staging|preview)\.propr\.dev$/.test(origin.hostname)
    || !/^[a-f0-9]{40}$/.test(config.sourceRevision ?? '')
    || !/^[a-f0-9]{64}$/.test(config.rpmSha256 ?? '')
    || !['x64', 'arm64'].includes(config.arch)
    || config.stateRoot !== '/var/lib/propr-desktop-live/state'
    || !['rpmPath', 'stateRoot'].every(key => typeof config[key] === 'string' && config[key].startsWith('/'))) {
    fail('configuration_failed');
  }
  return config;
}
export function assertRuntime(runtime, config) {
  try { validateDesktopRuntimeManifest(runtime, { sourceRevision: config.sourceRevision, distribution: 'published' }); }
  catch { fail('runtime_source_mismatch'); }
}
export function classifyBrowserUrl(value, apiOrigin) {
  const url = new URL(value);
  if (url.origin === 'https://github.com') {
    // OAuth redirects may proceed only with an existing grant; never click consent.
    if (url.pathname !== '/login/oauth/authorize') fail('reauthorization_required');
    return;
  }
  if (url.origin !== apiOrigin) fail('configuration_failed');
  if (url.pathname === '/login') {
    if (url.searchParams.has('error')) fail('app_pairing_failed');
    fail('reauthorization_required');
  }
}
export function assertMetadataAccess(response) {
  if (['GITHUB_AUTHORIZATION_REQUIRED', 'GITHUB_REAUTH_REQUIRED', 'TOKEN_EXPIRED'].includes(response.code)
    || (response.status === 401 && response.code !== 'TOKEN_REFRESHED')) fail('reauthorization_required');
  if (response.status !== 200) fail('repository_access_failed');
}
export async function assertPrivateTree(path) {
  const canonical = resolve(path);
  if (await realpath(canonical) !== canonical) fail('configuration_failed');
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077)) fail('configuration_failed');
}
const exec = promisify(execCallback);
const command = async (file, args) => {
  try { return (await exec(file, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch { fail('runtime_source_mismatch'); }
};
async function inspectInstalled(config) {
  if (process.platform !== 'linux' || process.arch !== config.arch) fail('configuration_failed');
  const rpmStat = await lstat(config.rpmPath);
  if (!rpmStat.isFile() || rpmStat.isSymbolicLink() || await realpath(config.rpmPath) !== config.rpmPath) fail('runtime_source_mismatch');
  const bytes = await readFile(config.rpmPath);
  if (createHash('sha256').update(bytes).digest('hex') !== config.rpmSha256) fail('runtime_source_mismatch');
  try {
    await verifyRpm({ path: config.rpmPath, identity: { fingerprint: OWNER_FINGERPRINT,
      publicKey: await readFile(new URL('../../../docs/static/keys/propr-desktop-release.asc', import.meta.url), 'utf8') } });
  } catch { fail('runtime_source_mismatch'); }
  // Compare installed package metadata with the signed bytes, then verify every installed file.
  const query = ['--qf', '%{NAME} %{VERSION} %{RELEASE} %{ARCH}\n', '--dump'];
  if (await command('rpm', ['-qp', ...query, config.rpmPath])
    !== await command('rpm', ['-q', ...query, 'propr-desktop'])) fail('runtime_source_mismatch');
  await command('rpm', ['-V', 'propr-desktop']);
  const runtime = JSON.parse(await readFile('/usr/lib/propr-desktop/resources/manifest.json', 'utf8'));
  assertRuntime(runtime, config);
  return runtime;
}

export async function verifyInstalled(config) {
  try { return await inspectInstalled(config); }
  catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail('runtime_source_mismatch');
  }
}

export async function runJourney(driver) {
  await driver.preflight();
  await driver.startPairing();
  await driver.browserSignIn();
  assertAccount(await driver.browserAccount());
  await driver.approve();
  assertAccount(await driver.confirmedAccount());
  await driver.connect();
  assertAccount(await driver.connectedAccount());
  if (!await driver.repositoryUsable(REPOSITORY)) fail('repository_access_failed');
}

export async function runLive(config) {
  const runtime = await verifyInstalled(config);
  await assertPrivateTree('/var/lib/propr-desktop-live');
  await assertPrivateTree(config.stateRoot);
  const browserRoot = join(config.stateRoot, 'browser');
  const desktopHome = join(config.stateRoot, 'desktop-home');
  for (const path of [browserRoot, desktopHome, join(desktopHome, '.config'),
    join(desktopHome, '.cache'), join(desktopHome, '.local'), join(desktopHome, '.local/share')]) {
    await mkdir(path, { mode: 0o700, recursive: true });
    await assertPrivateTree(path);
  }
  // Require a separate DBus session started by the operator wrapper. No inherited keyring.
  if (process.env.PROPR_LIVE_PRIVATE_DBUS !== '1' || !process.env.DBUS_SESSION_BUS_ADDRESS
    || process.env.GNOME_KEYRING_CONTROL || process.env.DEBUG || process.env.PWDEBUG
    || process.env.NODE_OPTIONS) fail('configuration_failed');
  const lock = await open(join(config.stateRoot, 'run.lock'), 'wx', 0o600).catch(() => fail('configuration_failed'));
  let browser, desktop, window, profile, rendererBrowser, handoffServer;
  let completed = false;
  const liveState = { url: null, confirmed: null, mismatch: false };
  try {
    // Unlock/create only the private, filesystem-restricted smoke keyring. No runner keyring is inherited.
    await new Promise((resolveUnlock, reject) => {
      const child = spawn('/usr/bin/gnome-keyring-daemon', ['--unlock', '--components=secrets'], {
        env: { PATH: '/usr/bin:/bin', HOME: desktopHome,
          XDG_DATA_HOME: join(desktopHome, '.local/share'), XDG_RUNTIME_DIR: join(config.stateRoot, 'runtime'),
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new SmokeFailure('configuration_failed')); }, 10_000);
      child.once('error', () => { clearTimeout(timer); reject(new SmokeFailure('configuration_failed')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolveUnlock() : reject(new SmokeFailure('configuration_failed')); });
      child.stdin.end('\n');
    });
    await mkdir(join(desktopHome, '.config'), { recursive: true, mode: 0o700 });
    const { chromium } = await import('playwright');
    const env = { PATH: '/usr/bin:/bin', HOME: desktopHome, XDG_CONFIG_HOME: join(desktopHome, '.config'),
      XDG_CACHE_HOME: join(desktopHome, '.cache'), XDG_DATA_HOME: join(desktopHome, '.local/share'), XDG_RUNTIME_DIR: join(config.stateRoot, 'runtime'), DISPLAY: process.env.DISPLAY,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
    browser = await chromium.launchPersistentContext(browserRoot, { headless: false, env,
      timeout: 30_000, acceptDownloads: false });
    // Block recovery/consent before any interaction. No traces, HAR, video, screenshots or console listeners.
    let browserFailure;
    await browser.route('**/*', async route => {
      if (route.request().isNavigationRequest()) {
        try { classifyBrowserUrl(route.request().url(), config.apiOrigin); }
        catch (error) { browserFailure = error; await route.abort(); return; }
      }
      await route.continue();
    });
    // Main-process inspection remains fused off. An owner-only socket routes the browser handoff.
    const socketPath = join(config.stateRoot, 'handoff.sock');
    await rm(socketPath, { force: true });
    handoffServer = createServer(socket => {
      let message = '';
      socket.setTimeout(5_000, () => socket.destroy());
      socket.on('data', chunk => {
        message += chunk.toString();
        if (message.length > 4096) { socket.destroy(); return; }
        if (!message.includes('\n')) return;
        let accepted = false;
        try {
          const record = JSON.parse(message.trim());
          if (record.event === 'handoff' && !liveState.url && typeof record.url === 'string') {
            const url = new URL(record.url);
            accepted = url.origin === config.apiOrigin && !url.search && !url.hash
              && /^\/api\/desktop\/pairings\/dpr_[A-Za-z0-9_-]{22}\/browser$/.test(url.pathname);
            if (accepted) liveState.url = record.url;
          } else if (record.event === 'confirmation' && liveState.url && typeof record.expected === 'boolean') {
            liveState.mismatch = !record.expected;
            liveState.confirmed = record.expected ? ACCOUNT : null;
            accepted = record.expected;
          }
        } catch { /* Never echo sensitive socket messages. */ }
        socket.end(`${JSON.stringify({ accepted })}\n`);
      });
    });
    await new Promise((resolveListen, reject) => {
      handoffServer.once('error', reject);
      handoffServer.listen(socketPath, resolveListen);
    });
    // Reserve an ephemeral loopback renderer debugger port. No Node debugger/fuse override.
    const reservation = createServer();
    await new Promise(resolveListen => reservation.listen(0, '127.0.0.1', resolveListen));
    const port = reservation.address().port;
    await new Promise(resolveClose => reservation.close(resolveClose));
    desktop = spawn('/usr/lib/propr-desktop/propr-desktop', [
      '--propr-live-github-smoke', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    ], { env: { ...env, PROPR_DESKTOP_LIVE_GITHUB_SMOKE: '1', PROPR_LIVE_PRIVATE_DBUS: '1',
      PROPR_DESKTOP_LIVE_CONFIG: process.env.PROPR_DESKTOP_LIVE_CONFIG }, stdio: 'ignore' });
    desktop.on('error', () => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      try { rendererBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_000 }); break; }
      catch { await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
    }
    if (!rendererBrowser) fail('app_pairing_failed');
    const context = rendererBrowser.contexts()[0];
    if (!context) fail('app_pairing_failed');
    window = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30_000 });
    await window.waitForFunction(() => Boolean(window.proprDesktop));
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    let pairing, scope;
    const desktopGet = async path => window.evaluate(async ({ origin, path, scope }) => {
      const response = await fetch(`${origin}${path}`, { headers: {
        'X-ProPR-Desktop-Transport-Scope': scope.transportScope }, credentials: 'omit' });
      const body = await response.json().catch(() => null);
      return { status: response.status, body: response.ok ? body : null,
        code: ['GITHUB_AUTHORIZATION_REQUIRED', 'GITHUB_REAUTH_REQUIRED', 'TOKEN_EXPIRED', 'TOKEN_REFRESHED']
          .includes(body?.code) ? body.code : null };
    }, { origin: config.apiOrigin, path, scope });
    const metadataGet = async path => {
      let response = await desktopGet(path);
      if (response.code === 'TOKEN_REFRESHED') response = await desktopGet(path);
      assertMetadataAccess(response);
      return response;
    };
    await runJourney({
      preflight: async () => {
        const discovery = await fetch(`${config.apiOrigin}/api/desktop/discovery`, {
          redirect: 'error', signal: AbortSignal.timeout(15_000) }).then(r => r.json());
        if (discovery.apiCompatibility !== runtime.desktopRuntime.apiCompatibility
          || discovery.desktopAuthentication?.protocolVersion !== 2) fail('api_compatibility_failed');
        const saved = await window.evaluate(() => window.proprDesktop.profiles.list());
        if (saved.profiles.some(p => p.account && p.account.username !== ACCOUNT)) fail('account_mismatch');
        const security = await window.evaluate(() => window.proprDesktop.storage.security());
        if (!security.available || security.backend === 'basic_text') fail('configuration_failed');
      },
      startPairing: async () => {
        profile = await window.evaluate(origin => window.proprDesktop.profiles.save({
          label: 'Nightly acceptance', apiBaseUrl: origin }), config.apiOrigin);
        // Always use a new browser handoff, even if a previous Desktop credential exists.
        pairing = window.evaluate(async profile => {
          const bridge = window.proprDesktop;
          const admission = await bridge.authentication.admit(profile.id);
          return bridge.authentication.pair({ id: profile.id, label: profile.label,
            apiBaseUrl: profile.apiBaseUrl }, admission.operationId);
        }, profile);
        void pairing.catch(() => {});
      },
      browserSignIn: async () => {
        let url;
        for (let i = 0; i < 100; i++) {
          url = liveState.url;
          if (url) break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (!url) fail('app_pairing_failed');
        const handoff = new URL(url);
        if (handoff.origin !== config.apiOrigin || !/^\/api\/desktop\/pairings\/dpr_[\w-]{22}\/browser$/.test(handoff.pathname)) fail('app_pairing_failed');
        // Exercise the server's GitHub sign-in path even with a cached ProPR session.
        // The redirect target is the exact Desktop-generated handoff, kept in memory.
        await page.goto(`${config.apiOrigin}/api/auth/github?redirect_to=${encodeURIComponent(url)}`).catch(() => {});
        for (let i = 0; i < 100; i++) {
          if (browserFailure) throw browserFailure;
          if (new URL(page.url()).origin === 'https://github.com'
            && await page.locator('form').count()) fail('reauthorization_required');
          if (await page.getByRole('button', { name: 'Approve desktop', exact: true }).isVisible()) return;
          await new Promise(r => setTimeout(r, 100));
        }
        fail('app_pairing_failed');
      },
      browserAccount: async () => {
        const response = await browser.request.get(`${config.apiOrigin}/api/auth/user`, { maxRedirects: 0 });
        if (response.status() === 401) fail('reauthorization_required');
        if (response.status() === 403) fail('repository_access_failed');
        if (!response.ok()) fail('app_pairing_failed');
        return (await response.json()).username;
      },
      approve: () => page.getByRole('button', { name: 'Approve desktop', exact: true }).click(),
      confirmedAccount: async () => {
        const result = await pairing;
        const native = liveState;
        if (native.mismatch || result.code === 'ACCOUNT_MISMATCH') fail('account_mismatch');
        if (!result.paired) fail('app_pairing_failed');
        return native.confirmed;
      },
      connect: async () => {
        const probe = await window.evaluate(profile => window.proprDesktop.connection.probe({
          id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl }), profile);
        if (probe.status === 'incompatible') fail('api_compatibility_failed');
        if (probe.status !== 'ready') fail('app_pairing_failed');
        scope = await window.evaluate(ticket => window.proprDesktop.connection.activate(ticket), probe.activationTicket);
      },
      connectedAccount: async () => {
        const result = await desktopGet('/api/auth/user');
        if (result.status === 401) fail('app_pairing_failed');
        if (result.status !== 200) fail('app_pairing_failed');
        return result.body.username;
      },
      repositoryUsable: async repository => {
        const repos = await metadataGet('/api/github/repos');
        if (!repos.body?.repos?.includes(repository)) return false;
        const branches = await metadataGet(`/api/github/repos/${repository}/branches`);
        return branches.status === 200 && Array.isArray(branches.body?.branches) && branches.body.branches.length > 0;
      },
    });
    completed = true;
  } finally {
    let cleanupFailed = false;
    // Removing this run's profile uses the production revocation path. Never accumulate nightly tokens.
    if (window && profile) await window.evaluate(id => window.proprDesktop.profiles.remove(id), profile.id).catch(() => { cleanupFailed = true; });
    await rendererBrowser?.close().catch(() => {});
    desktop?.kill('SIGTERM');
    if (handoffServer) await new Promise(resolveClose => handoffServer.close(resolveClose));
    await rm(join(config.stateRoot, 'handoff.sock'), { force: true });
    await browser?.close().catch(() => {});
    await lock.close();
    await rm(join(config.stateRoot, 'run.lock'), { force: true });
    if (completed && cleanupFailed) fail('app_pairing_failed');
  }
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  let error;
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  const timer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify(resultRecord(new SmokeFailure('app_pairing_failed'), dryRun))}\n`);
    process.exit(1);
  }, 180_000);
  try {
    if (dryRun) {
      const { fixtureDriver } = await import('./live-github-smoke-fixture.mjs');
      await runJourney(fixtureDriver());
    } else {
      if (args.length || process.env.PROPR_DESKTOP_LIVE_GITHUB_SMOKE !== '1') fail('configuration_failed');
      const configPath = process.env.PROPR_DESKTOP_LIVE_CONFIG;
      const stat = await lstat(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('configuration_failed');
      await runLive(validateConfig(JSON.parse(await readFile(configPath, 'utf8'))));
    }
  } catch (caught) { error = caught; }
  clearTimeout(timer);
  const record = resultRecord(error, dryRun);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = record.result === 'passed' ? 0 : record.result === 'reauthorization_required' ? 2 : 1;
  return record;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main();
