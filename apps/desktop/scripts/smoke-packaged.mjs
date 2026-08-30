import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DESKTOP_RENDERER_ORIGIN,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';

const READY_EVENT = 'desktop.renderer.ready';
const PRELOAD_BRIDGE_PROOF = '"preloadBridgeExposed":true';
const TRANSPORT_PROOF = 'desktop.renderer.transport_smoke.ready';
const MAIN_PROCESS_ERROR_MARKERS = [
  'desktop.main_process.uncaught_exception',
  'A JavaScript error occurred in the main process',
  'Uncaught Exception:',
];
const TIMEOUT_MS = 45_000;
const artifact = process.platform === 'linux'
  ? [`propr-desktop-linux-${process.arch}`, 'propr-desktop']
  : process.platform === 'win32'
    ? [`propr-desktop-win32-${process.arch}`, 'propr-desktop.exe']
    : null;
if (!artifact) throw new Error('The packaged transport smoke requires Linux or Windows');
const binaryPath = resolve('out', ...artifact);

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
const upgradedSockets = new Set();
const fixtures = [];
const corsHeaders = {
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type, X-ProPR-Desktop-Transport-Scope',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
  'Access-Control-Allow-Private-Network': 'true',
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
      upgrade: false,
    };
    requests.push(record);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
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
  server.on('upgrade', (request, socket) => {
    const record = {
      fixture: name,
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
      origin: request.headers.origin ?? null,
      upgrade: true,
    };
    requests.push(record);
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string'
      || !request.url?.startsWith('/socket.io/?')
      || !request.url.includes('transport=websocket')
      || !request.url.includes('proprDesktopTransportScope=')
      || !/^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(record.authorization ?? '')) {
      socket.destroy();
      return;
    }
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`Packaged ${name} fixture did not bind`);
  const fixture = { server, origin: `http://127.0.0.1:${address.port}` };
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
const userDataPath = await mkdtemp(resolve(tmpdir(), 'propr-desktop-smoke-'));
const launchArguments = ['--disable-gpu', `--user-data-dir=${userDataPath}`];
if (launchArguments.some(argument => argument === '--no-sandbox' || argument === '--disable-sandbox')) {
  throw new Error('The packaged-binary smoke test must not disable Electron sandboxing');
}

let output = '';
try {
  const child = spawn(binaryPath, launchArguments, {
    env: {
      ...process.env,
      PROPR_DESKTOP_SMOKE_FIRST_ORIGIN: first.origin,
      PROPR_DESKTOP_SMOKE_SECOND_ORIGIN: second.origin,
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
      reject(new Error(`Packaged desktop transport smoke exceeded ${TIMEOUT_MS / 1000} seconds`));
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
  if (!output.includes(READY_EVENT) || !output.includes(PRELOAD_BRIDGE_PROOF) || !output.includes(TRANSPORT_PROOF)) {
    throw new Error('Packaged desktop did not publish the complete renderer transport proof');
  }

  const authenticated = requests.filter(request => request.authorization?.startsWith('Bearer propr_it_'));
  const secrets = [...new Set(authenticated.map(request => request.authorization.slice('Bearer '.length)))];
  if (secrets.length !== 2) throw new Error(`Expected two activation credentials, observed ${secrets.length}`);
  for (const name of ['first', 'second']) {
    const fixtureRequests = authenticated.filter(request => request.fixture === name);
    if (!fixtureRequests.some(request => request.url === '/api/auth/user')
      || !fixtureRequests.some(request => request.url === '/api/smoke/rest')
      || !fixtureRequests.some(request => request.upgrade)) {
      throw new Error(`Packaged ${name} fixture missed REST, probe, or Socket.IO bearer interception`);
    }
    if (new Set(fixtureRequests.map(request => request.authorization)).size !== 1) {
      throw new Error(`Packaged ${name} fixture observed cross-generation bearer use`);
    }
  }
  if (authenticated.some(request => request.cookie !== null)
    || requests.some(request => secrets.some(secret => request.url?.includes(secret)))) {
    throw new Error('Packaged renderer transport sent cookies or placed a credential in a URL');
  }
  if (secrets.some(secret => output.includes(secret) || launchArguments.some(argument => argument.includes(secret)))) {
    throw new Error('Packaged credential entered stdout, stderr, or argv');
  }
  if (await scanPathsForSecrets([
    join(userDataPath, 'logs'),
    join(userDataPath, 'Crashpad'),
    join(userDataPath, 'crashpad'),
  ], secrets)) {
    throw new Error('Packaged credential entered logs or crash metadata');
  }

  console.log(
    `Packaged ${process.platform} desktop transport smoke passed: custom protocol, session interception, `
    + 'REST/Socket.IO bearer rotation, no cookies, both-origin cleanup, stale-scope fencing, and secret custody.',
  );
} finally {
  for (const socket of upgradedSockets) socket.destroy();
  for (const { server } of fixtures) {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  await rm(userDataPath, { recursive: true, force: true });
}
