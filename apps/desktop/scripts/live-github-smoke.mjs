// This harness never prints provider/application diagnostics or serializes sessions.
import { spawn, execFile as execCallback } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, open, rm, readlink, stat, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyRpm, OWNER_FINGERPRINT } from './rpm-signing.mjs';
import { validateDesktopRuntimeManifest } from './desktop-runtime-manifest.mjs';

export const ACCOUNT = 'propr-ultrafix';
export const ACCOUNT_ID = '297689653';
export const EXPECTED_ACCOUNT = Object.freeze({ username: ACCOUNT, id: ACCOUNT_ID });
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
export function assertAccount(account) {
  if (account?.username !== ACCOUNT || account?.id !== ACCOUNT_ID) fail('account_mismatch');
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

// The abort stops new journey mutations; cleanup uses its own bounded calls.
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function runJourney(driver, signal) {
  const step = async name => {
    signal?.throwIfAborted();
    const result = await (name === 'startPairing' ? driver[name]() : abortable(driver[name](), signal));
    signal?.throwIfAborted();
    return result;
  };
  await step('preflight');
  await step('startPairing');
  await step('browserSignIn');
  assertAccount(await step('browserAccount'));
  await step('approve');
  assertAccount(await step('confirmedAccount'));
  await step('connect');
  assertAccount(await step('connectedAccount'));
  signal?.throwIfAborted();
  if (!await abortable(driver.repositoryUsable(REPOSITORY), signal)) fail('repository_access_failed');
  signal?.throwIfAborted();
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export async function acquireRunLock(root) {
  // Kernel serialization also covers stale-file reclamation: two contenders
  // cannot unlink a replacement lock after observing the same dead PID.
  const guard = await open(join(root, 'run.guard'), 'a+', 0o600);
  const metadata = await guard.stat();
  if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) {
    await guard.close(); fail('configuration_failed');
  }
  const owner = spawn('/usr/bin/flock', ['--nonblock', '/proc/self/fd/3', process.execPath, '-e',
    "process.stdout.write('ready'); process.stdin.resume()"],
    { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore', guard.fd] });
  owner.stdin.on('error', () => {});
  const exited = new Promise(resolve => owner.once('close', resolve));
  const releaseGuard = async () => { owner.stdin.end(); await exited; await guard.close(); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { owner.kill('SIGKILL'); reject(new SmokeFailure('configuration_failed')); }, 5_000);
      owner.once('error', () => { clearTimeout(timer); reject(new SmokeFailure('configuration_failed')); });
      owner.once('exit', () => { clearTimeout(timer); reject(new SmokeFailure('configuration_failed')); });
      owner.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    const releasePid = await acquirePidLock(root);
    return async () => { try { await releasePid(); } finally { await releaseGuard(); } };
  } catch (error) { await releaseGuard(); throw error; }
}
async function acquirePidLock(root) {
  const path = join(root, 'run.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Publish an already-written PID atomically; a kill before publication
      // must not leave an empty lock that requires operator recovery.
      const temporary = join(root, `.run.lock-${randomUUID()}`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
        await link(temporary, path);
      } catch (error) { await handle.close(); throw error; }
      finally { await rm(temporary, { force: true }); }
      const identity = await handle.stat();
      return async () => {
        await handle.close();
        const current = await lstat(path).catch(() => null);
        if (current?.ino === identity.ino && current?.dev === identity.dev) await rm(path);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const identity = await lstat(path);
      if (!identity.isFile() || identity.uid !== process.getuid() || (identity.mode & 0o077)) fail('configuration_failed');
      const contents = await readFile(path, 'utf8');
      const pid = Number(contents.trim());
      // Empty/malformed locks and reused live PIDs require operator inspection.
      if (!/^[1-9][0-9]*\n$/.test(contents) || !Number.isSafeInteger(pid) || pidAlive(pid)) fail('configuration_failed');
      const current = await lstat(path).catch(() => null);
      if (current?.ino === identity.ino && current?.dev === identity.dev) await rm(path);
    }
  }
  fail('configuration_failed');
}

// Linux Playwright browser leaders are detached from the wrapper's process group.
// Under the run lock, recover only this owner's exact dedicated profile browser.
export async function recoverBrowser(root) {
  const path = join(root, 'SingletonLock');
  let target;
  try { target = await readlink(path); }
  catch (error) { if (error.code === 'ENOENT') return; fail('configuration_failed'); }
  const { hostname } = await import('node:os');
  const prefix = `${hostname()}-`;
  if (!target.startsWith(prefix) || !/^[1-9][0-9]*$/.test(target.slice(prefix.length))) fail('configuration_failed');
  const pid = Number(target.slice(prefix.length));
  if (pidAlive(pid)) {
    const owner = await stat(`/proc/${pid}`);
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (owner.uid !== process.getuid() || !args.includes(`--user-data-dir=${root}`)
      || !args[0].startsWith('/var/lib/propr-desktop-live/playwright/') || args.some(arg => arg.startsWith('--type='))) fail('configuration_failed');
    // Signal the verified browser, not an arbitrary process group from a stale PID.
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise(r => setTimeout(r, 100));
    if (pidAlive(pid)) fail('configuration_failed');
  }
  if (await readlink(path).catch(() => null) !== target) fail('configuration_failed');
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) await rm(join(root, name), { force: true });
}

// Chromium CDP pipe framing is NUL-delimited JSON on inherited fds 3/4.
export function pipeRenderer(child) {
  let nextId = 0, buffer = '', sessionId;
  const pending = new Map();
  const stop = () => {
    for (const call of pending.values()) call.reject(new SmokeFailure('app_pairing_failed'));
    pending.clear();
  };
  child.stdio[4].on('data', bytes => {
    buffer += bytes.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(frame); } catch { stop(); return; }
      const call = pending.get(message.id);
      if (!call) continue;
      pending.delete(message.id);
      if (message.error) call.reject(new SmokeFailure('app_pairing_failed'));
      else call.resolve(message.result);
    }
  });
  child.stdio[3].on('error', stop);
  child.stdio[4].on('error', stop);
  child.once('exit', stop);
  const send = (method, params = {}, session = sessionId, timeout = 20_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new SmokeFailure('app_pairing_failed')); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`);
  });
  const evaluate = async (fn, arg, timeout) => {
    const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`,
      awaitPromise: true, returnByValue: true }, sessionId, timeout);
    if (result.exceptionDetails) fail('app_pairing_failed');
    return result.result.value;
  };
  return {
    evaluate,
    ready: async signal => {
      for (let i = 0; i < 100; i++) {
        signal?.throwIfAborted();
        const { targetInfos } = await send('Target.getTargets', {}, null);
        const target = targetInfos.find(t => t.type === 'page' && !t.url.startsWith('devtools:'));
        if (target) {
          const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
          sessionId = attached.sessionId;
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!sessionId) fail('app_pairing_failed');
      for (let i = 0; i < 100; i++) {
        signal?.throwIfAborted();
        if (await evaluate(() => Boolean(window.proprDesktop))) return;
        await new Promise(r => setTimeout(r, 100));
      }
      fail('app_pairing_failed');
    },
    close: () => { stop(); child.stdio[3].destroy(); child.stdio[4].destroy(); },
  };
}

export async function runLive(config, signal) {
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
  signal?.throwIfAborted();
  const releaseLock = await acquireRunLock(config.stateRoot);
  let browser, desktop, window, profile, handoffServer;
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
    await recoverBrowser(browserRoot);
    signal?.throwIfAborted();
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
            liveState.confirmed = record.expected ? EXPECTED_ACCOUNT : null;
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
    signal?.throwIfAborted();
    desktop = spawn('/usr/lib/propr-desktop/propr-desktop', [
      '--propr-live-github-smoke', '--remote-debugging-pipe',
    ], { env: { ...env, PROPR_DESKTOP_LIVE_GITHUB_SMOKE: '1', PROPR_LIVE_PRIVATE_DBUS: '1',
      PROPR_DESKTOP_LIVE_CONFIG: process.env.PROPR_DESKTOP_LIVE_CONFIG },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    desktop.on('error', () => {});
    window = pipeRenderer(desktop);
    await window.ready(signal);
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    let pairing, scope;
    const desktopGet = async path => {
      signal?.throwIfAborted();
      return window.evaluate(async ({ origin, path, scope }) => {
      const response = await fetch(`${origin}${path}`, { headers: {
        'X-ProPR-Desktop-Transport-Scope': scope.transportScope }, credentials: 'omit' });
      const body = await response.json().catch(() => null);
      return { status: response.status, body: response.ok ? body : null,
        code: ['GITHUB_AUTHORIZATION_REQUIRED', 'GITHUB_REAUTH_REQUIRED', 'TOKEN_EXPIRED', 'TOKEN_REFRESHED']
          .includes(body?.code) ? body.code : null };
    }, { origin: config.apiOrigin, path, scope });
    };
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
        for (const p of saved.profiles) if (p.account) assertAccount(p.account);
        // Recover this smoke's durable profile obligations from an interrupted run.
        for (const p of saved.profiles) {
          if (p.label !== 'Nightly acceptance' || p.apiBaseUrl !== config.apiOrigin) fail('configuration_failed');
          signal?.throwIfAborted();
          await window.evaluate(id => window.proprDesktop.profiles.remove(id), p.id);
        }
        const security = await window.evaluate(() => window.proprDesktop.storage.security());
        if (!security.available || security.backend === 'basic_text') fail('configuration_failed');
      },
      startPairing: async () => {
        profile = { id: randomUUID(), label: 'Nightly acceptance', apiBaseUrl: config.apiOrigin };
        await window.evaluate(profile => window.proprDesktop.profiles.save(profile), profile);
        signal?.throwIfAborted();
        // Always use a new browser handoff, even if a previous Desktop credential exists.
        pairing = window.evaluate(async profile => {
          const bridge = window.proprDesktop;
          const admission = await bridge.authentication.admit(profile.id);
          return bridge.authentication.pair({ id: profile.id, label: profile.label,
            apiBaseUrl: profile.apiBaseUrl }, admission.operationId);
        }, profile, 180_000);
        void pairing.catch(() => {});
      },
      browserSignIn: async () => {
        let url;
        for (let i = 0; i < 100; i++) {
          signal?.throwIfAborted();
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
          signal?.throwIfAborted();
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
        return await response.json();
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
        signal?.throwIfAborted();
        if (probe.status === 'incompatible') fail('api_compatibility_failed');
        if (probe.status !== 'ready') fail('app_pairing_failed');
        scope = await window.evaluate(ticket => window.proprDesktop.connection.activate(ticket), probe.activationTicket);
      },
      connectedAccount: async () => {
        const result = await desktopGet('/api/auth/user');
        if (result.status === 401) fail('app_pairing_failed');
        if (result.status !== 200) fail('app_pairing_failed');
        return result.body;
      },
      repositoryUsable: async repository => {
        const repos = await metadataGet('/api/github/repos');
        if (!repos.body?.repos?.includes(repository)) return false;
        const branches = await metadataGet(`/api/github/repos/${repository}/branches`);
        return branches.status === 200 && Array.isArray(branches.body?.branches) && branches.body.branches.length > 0;
      },
    }, signal);
    completed = true;
  } finally {
    await cleanupLiveRun({ window, profile, desktop, handoffServer, browser, releaseLock,
      stateRoot: config.stateRoot, completed });
  }
}

export async function cleanupLiveRun({ window, profile, desktop, handoffServer, browser, releaseLock, stateRoot, completed }) {
  let cleanupFailed = false;
  // Cancellation settles mutation authority before removal journals revocation.
  try {
    if (window && profile) await window.evaluate(async id => {
      await window.proprDesktop.authentication.cancel(id);
      await window.proprDesktop.profiles.remove(id);
    }, profile.id).catch(() => { cleanupFailed = true; });
    window?.close();
    desktop?.kill('SIGTERM');
    if (handoffServer) await new Promise(resolveClose => handoffServer.close(resolveClose));
    await rm(join(stateRoot, 'handoff.sock'), { force: true });
    if (browser) await Promise.race([browser.close().catch(() => { cleanupFailed = true; }),
      new Promise(resolve => { const timer = setTimeout(() => { cleanupFailed = true; resolve(); }, 5_000); timer.unref(); })]);
  } finally {
    await releaseLock();
  }
  if (completed && cleanupFailed) fail('app_pairing_failed');
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  let error;
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SmokeFailure('app_pairing_failed')), 180_000);
  // Last resort only: allow the normal deadline to unwind and clean up first.
  const fallback = setTimeout(() => {
    process.stdout.write(`${JSON.stringify(resultRecord(new SmokeFailure('app_pairing_failed'), dryRun))}\n`);
    process.exit(1);
  }, 240_000);
  try {
    if (dryRun) {
      const { fixtureDriver } = await import('./live-github-smoke-fixture.mjs');
      await runJourney(fixtureDriver(), controller.signal);
    } else {
      if (args.length || process.env.PROPR_DESKTOP_LIVE_GITHUB_SMOKE !== '1') fail('configuration_failed');
      const configPath = process.env.PROPR_DESKTOP_LIVE_CONFIG;
      const stat = await lstat(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('configuration_failed');
      await runLive(validateConfig(JSON.parse(await readFile(configPath, 'utf8'))), controller.signal);
    }
  } catch (caught) { error = caught; }
  clearTimeout(timer);
  clearTimeout(fallback);
  const record = resultRecord(error, dryRun);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = record.result === 'passed' ? 0 : record.result === 'reauthorization_required' ? 2 : 1;
  return record;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main();
