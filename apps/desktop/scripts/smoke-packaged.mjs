import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server as SocketIOServer } from 'socket.io';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_QUERY,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';
import { assertPackagedLayout } from './packaged-layout.mjs';

const READY_EVENT = 'desktop.renderer.ready';
const PRELOAD_BRIDGE_PROOF = '"preloadBridgeExposed":true';
const TRANSPORT_PROOF = 'desktop.renderer.transport_smoke.ready';
const LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
const MAIN_PROCESS_ERROR_MARKERS = [
  'desktop.main_process.uncaught_exception',
  'A JavaScript error occurred in the main process',
  'Uncaught Exception:',
];
const TIMEOUT_MS = 45_000;
const INVALID_INSTANCE_TOKEN = 'INVALID_INSTANCE_TOKEN';
const artifact = process.platform === 'linux'
  ? [`propr-desktop-linux-${process.arch}`, 'propr-desktop']
  : process.platform === 'win32'
    ? [`propr-desktop-win32-${process.arch}`, 'propr-desktop.exe']
    : null;
if (!artifact) throw new Error('The packaged transport smoke requires Linux or Windows');
const binaryPath = resolve('out', ...artifact);

const parseLayout = smokeOutput => {
  for (const line of smokeOutput.split(/\r?\n/)) {
    if (!line.includes(LAYOUT_READY_EVENT)) continue;
    try {
      const record = JSON.parse(line.slice(line.indexOf('{')));
      if (record.event === LAYOUT_READY_EVENT) return record.layout;
    } catch {
      // Ignore non-JSON Chromium output that happens to mention the event name.
    }
  }
  return undefined;
};

await access(binaryPath);

const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);
const actualFuses = await getCurrentFuseWire(binaryPath);
if (actualFuses.version !== FuseVersion.V1) {
  throw new Error(`Expected fuse wire version ${FuseVersion.V1}, received ${actualFuses.version}`);
}
for (const [fuse, expectedState] of expectedFuses) {
  const actualState = actualFuses[fuse];
  if (actualState !== expectedState) {
    throw new Error(
      `Unexpected ${FuseV1Options[fuse]} fuse state: expected ${FuseState[expectedState]}, received ${FuseState[actualState] ?? actualState}`,
    );
  }
}

const requests = [];
const fixtures = [];
const corsHeaders = {
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type, X-ProPR-Desktop-Transport-Scope',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
  'Access-Control-Allow-Private-Network': 'true',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
const discovery = JSON.stringify({
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  desktopAuthentication: {
    protocolVersion: 2,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
});

const listenFixture = async name => {
  const server = createServer((request, response) => {
    const record = {
      fixture: name,
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
      origin: request.headers.origin ?? null,
      socketIo: false,
    };
    requests.push(record);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    if (request.url === '/smoke-storage') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>storage fixture</title>');
      return;
    }
    if (request.url === '/smoke-sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
      response.end("self.addEventListener('fetch', () => undefined);");
      return;
    }
    if (request.url === '/api/desktop/discovery') {
      response.writeHead(200, { ...corsHeaders, 'Set-Cookie': 'discovery=must-not-persist; HttpOnly; SameSite=None' });
      response.end(discovery);
      return;
    }
    if (request.method === 'DELETE' && request.url === '/api/desktop/tokens/current') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }
    if ((request.url === '/api/auth/user' || request.url === '/api/smoke/rest')
      && /^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(record.authorization ?? '')) {
      response.writeHead(200, { ...corsHeaders, 'Set-Cookie': 'remote=must-not-persist; HttpOnly; SameSite=None' });
      response.end(request.url === '/api/auth/user' ? '{"username":"packaged-smoke"}' : '{"ok":true}');
      return;
    }
    response.writeHead(401, corsHeaders);
    response.end('{"code":"INVALID_INSTANCE_TOKEN"}');
  });
  const io = new SocketIOServer(server, {
    path: '/socket.io/',
    transports: ['websocket'],
    cors: { origin: DESKTOP_RENDERER_ORIGIN, credentials: false },
  });
  io.of('/').use((socket, next) => {
    const queryScopes = new URL(socket.handshake.url, 'http://fixture.invalid')
      .searchParams.getAll(DESKTOP_TRANSPORT_SCOPE_QUERY);
    const activationScope = socket.handshake.auth?.[DESKTOP_TRANSPORT_SCOPE_QUERY];
    const record = {
      fixture: name,
      method: 'SOCKET.IO',
      url: socket.handshake.url,
      authorization: socket.handshake.headers.authorization ?? null,
      cookie: socket.handshake.headers.cookie ?? null,
      origin: socket.handshake.headers.origin ?? null,
      socketIo: true,
      namespace: socket.nsp.name,
      engineProtocol: socket.conn.protocol,
    };
    requests.push(record);
    if (!/^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(record.authorization ?? '')
      || queryScopes.length !== 1 || typeof activationScope !== 'string'
      || activationScope !== queryScopes[0]) {
      const error = new Error(INVALID_INSTANCE_TOKEN);
      error.data = { code: INVALID_INSTANCE_TOKEN };
      next(error);
      return;
    }
    next();
  });
  io.of('/').on('connection', socket => socket.emit('packaged-smoke:connected', { ok: true }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`Packaged ${name} fixture did not bind`);
  const fixture = { server, io, origin: `http://127.0.0.1:${address.port}` };
  fixtures.push(fixture);
  return fixture;
};

const scanPathsForSecrets = async (paths, secrets) => {
  const visit = async path => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (await visit(child)) return true;
      } else {
        const bytes = await readFile(child);
        if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) return true;
      }
    }
    return false;
  };
  for (const path of paths) if (await visit(path)) return true;
  return false;
};

const first = await listenFixture('first');
const second = await listenFixture('second');
const runs = [];
const createdUserDataPaths = [];
const shutdownSteps = [
  'admission-closed',
  'ipc-closed',
  'session-closed',
  'protocol-disposed',
  'credentials-dispose-started',
  'authentication-cleared',
  'lifecycle-drain-started',
  'ipc-drain-started',
  'service-drain-finished',
  'profiles-close-started',
  'profiles-close-finished',
  'session-disposed',
  'ipc-disposed',
  'window-destroyed',
  'final-quit',
];

const launch = async mode => {
  const userDataPath = await mkdtemp(resolve(tmpdir(), `propr-desktop-smoke-${mode}-`));
  createdUserDataPaths.push(userDataPath);
  const launchArguments = [
    '--disable-gpu',
    `--user-data-dir=${userDataPath}`,
    ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
  ];
  if (launchArguments.some(argument => argument === '--no-sandbox' || argument === '--disable-sandbox')) {
    throw new Error('The packaged-binary smoke test must not disable Electron sandboxing');
  }
  const requestStart = requests.length;
  let output = '';
  const child = spawn(binaryPath, launchArguments, {
    env: {
      ...process.env,
      PROPR_DESKTOP_SMOKE_FIRST_ORIGIN: first.origin,
      PROPR_DESKTOP_SMOKE_SECOND_ORIGIN: second.origin,
      PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE: mode,
      PROPR_DESKTOP_SMOKE_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const capture = chunk => {
    const value = chunk.toString();
    output += value;
    process.stdout.write(value);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const result = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Packaged desktop ${mode} smoke exceeded ${TIMEOUT_MS / 1000} seconds`));
    }, TIMEOUT_MS);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal });
    });
  });

  const mainProcessError = MAIN_PROCESS_ERROR_MARKERS.find(marker => output.includes(marker));
  if (mainProcessError) throw new Error(`Packaged desktop reported an uncaught exception (${mainProcessError})`);
  if (result.code !== 0) {
    throw new Error(`Packaged desktop exited with code ${result.code ?? 'null'} (signal ${result.signal ?? 'none'})`);
  }
  const socketShutdownDeadline = Date.now() + 2_000;
  while (fixtures.some(fixture => fixture.io.of('/').sockets.size !== 0)
    && Date.now() < socketShutdownDeadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  if (fixtures.some(fixture => fixture.io.of('/').sockets.size !== 0)) {
    throw new Error(`Packaged ${mode} shutdown left late authenticated Socket.IO work alive`);
  }
  if (!output.includes(READY_EVENT) || !output.includes(PRELOAD_BRIDGE_PROOF) || !output.includes(TRANSPORT_PROOF)) {
    throw new Error('Packaged desktop did not publish the complete renderer transport proof');
  }
  const expectedBackend = process.platform === 'linux' ? 'gnome_libsecret' : 'os-protected';
  if (!output.includes(`"storageBackend":"${expectedBackend}"`)) {
    throw new Error(`Packaged desktop did not use ${expectedBackend} production credential protection`);
  }
  let previousStep = -1;
  for (const step of shutdownSteps) {
    const marker = `"step":"${step}"`;
    if (output.split(marker).length - 1 !== 1 || output.indexOf(marker) <= previousStep) {
      throw new Error(`Packaged ${mode} shutdown did not run ${step} exactly once in order`);
    }
    previousStep = output.indexOf(marker);
  }
  const forced = output.includes('desktop.app.shutdown_forced');
  if (forced !== (mode === 'forced-timeout')) throw new Error(`Packaged ${mode} forced-timeout evidence was incorrect`);
  if (mode === 'retry' && (!output.includes('desktop.app.shutdown_retry_requested')
    || !output.includes('desktop.app.shutdown_retry'))) {
    throw new Error('Packaged retry did not exercise a repeated prevented before-quit event');
  }
  assertPackagedLayout(parseLayout(output));

  const runRequests = requests.slice(requestStart);
  const authenticated = runRequests.filter(request => request.authorization?.startsWith('Bearer propr_it_'));
  const secrets = [...new Set(authenticated.map(request => request.authorization.slice('Bearer '.length)))];
  if (secrets.length !== 2) throw new Error(`Expected two ${mode} activation credentials, observed ${secrets.length}`);
  for (const name of ['first', 'second']) {
    const fixtureRequests = authenticated.filter(request => request.fixture === name);
    const namespaceConnections = fixtureRequests.filter(request => request.socketIo);
    if (!fixtureRequests.some(request => request.url === '/api/auth/user')
      || !fixtureRequests.some(request => request.url === '/api/smoke/rest')
      || namespaceConnections.length < (name === 'second' ? 2 : 1)
      || namespaceConnections.some(request => request.namespace !== '/' || request.engineProtocol !== 4)) {
      throw new Error(`Packaged ${mode} ${name} fixture missed REST, Engine.IO, namespace auth, or reconnect proof`);
    }
    if (new Set(fixtureRequests.map(request => request.authorization)).size !== 1) {
      throw new Error(`Packaged ${mode} ${name} fixture observed cross-generation bearer use`);
    }
  }
  if (runRequests.some(request => request.cookie !== null)
    || runRequests.some(request => secrets.some(secret => request.url?.includes(secret)))) {
    throw new Error('Packaged renderer transport sent cookies or placed a credential in a URL');
  }
  if (secrets.some(secret => output.includes(secret) || launchArguments.some(argument => argument.includes(secret)))) {
    throw new Error('Packaged credential entered stdout, stderr, or argv');
  }
  const credentialFiles = await readdir(join(userDataPath, 'desktop', 'credentials'));
  if (credentialFiles.length === 0 || await scanPathsForSecrets([userDataPath], secrets)) {
    throw new Error('Packaged credential material was missing or plaintext anywhere under isolated userData');
  }
  runs.push({ mode, userDataPath, output, launchArguments, secrets });
};

try {
  for (const mode of ['success', 'retry', 'forced-timeout']) await launch(mode);
  const allSecrets = runs.flatMap(run => run.secrets);
  const scanRoots = [
    ...runs.map(run => run.userDataPath),
    ...(process.env.PROPR_DESKTOP_SMOKE_KEYRING_ROOT ? [resolve(process.env.PROPR_DESKTOP_SMOKE_KEYRING_ROOT)] : []),
  ];
  if (await scanPathsForSecrets(scanRoots, allSecrets)) {
    throw new Error('A packaged credential entered the isolated userData or OS keyring scan roots');
  }
  console.log(
    `Packaged ${process.platform} desktop transport smoke passed (3/3 shutdown modes): production OS credentials, `
    + 'real Socket.IO/Engine.IO namespace auth, scope rotation/reconnect/error handling, five-type both-origin '
    + `rollback cleanup, compiled welcome-card layout, no cookies, and byte scans of ${scanRoots.join(', ')}.`,
  );
} finally {
  for (const { io, server } of fixtures) {
    await new Promise(resolveClose => io.close(resolveClose));
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
  }
  for (const userDataPath of createdUserDataPaths) await rm(userDataPath, { recursive: true, force: true });
}
