import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import {
  DESKTOP_RENDERER_ORIGIN, DESKTOP_TRANSPORT_SCOPE_HEADER, DESKTOP_TRANSPORT_SCOPE_QUERY,
  PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import { createIdempotentJourneyFixtureClose } from './packaged-connect-lifecycle.mjs';
import { isExpectedScopedCurrentUserRequest } from './packaged-acceptance-current-user.mjs';

const identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const isExpectedCurrentUserRequest = request => isExpectedScopedCurrentUserRequest(request.method, request.url, 1);
// Synthetic public identity, shared by confirmation, saved-account reprobes, and renderer validation.
export const PACKAGED_CONNECT_ACCOUNT = Object.freeze({ id: '2290', username: 'packaged-owner', avatarUrl: null });

export const createPackagedJourneyFixture = async ({ approvalReadinessDelayMs = process.platform === 'darwin' ? 300 : 0 } = {}) => {
  const pairingId = `dpr_${'P'.repeat(22)}`;
  const deviceSecret = 'D'.repeat(43);
  const activationTicket = 'A'.repeat(43);
  const token = `propr_it_${'T'.repeat(43)}`;
  const receipt = 'R'.repeat(22);
  const requests = [];
  let endpoint;
  let approved = false;
  let active = false;
  let binding;
  let mode = 'success';
  let modeGeneration = 0;
  const cors = {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ProPR-Desktop-Transport-Scope',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  };
  const readJson = request => new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024) {
        rejectBody(new Error('oversized request'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { rejectBody(error); }
    });
    request.on('error', rejectBody);
  });
  const server = createServer(async (request, response) => {
    const record = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      origin: request.headers.origin ?? null,
      transportScope: request.headers[DESKTOP_TRANSPORT_SCOPE_HEADER.toLowerCase()] ?? null,
      credentialHeadersPresent: Object.keys(request.headers).some(name =>
        ['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())),
      socketIo: false,
      fixtureMode: mode,
      fixtureModeGeneration: modeGeneration,
    };
    requests.push(record);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    try {
      if (request.method === 'POST' && request.url?.startsWith('/__packaged/control/')) {
        const requestedMode = request.url.slice('/__packaged/control/'.length);
        if (!['success', 'malformed', 'oversized', 'expiry', 'cancel'].includes(requestedMode)) {
          throw new Error('invalid fixture mode');
        }
        mode = requestedMode;
        modeGeneration += 1;
        approved = false;
        binding = undefined;
        response.writeHead(204, cors);
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/__packaged/evidence') {
        const authenticatedRest = requests.filter(item => item.socketIo === false
          && isExpectedCurrentUserRequest(item)
          && item.authorization === `Bearer ${token}`
          && item.transportScope === null);
        const authenticatedSockets = requests.filter(item => item.socketIo === true
          && item.accepted === true
          && item.authorization === `Bearer ${token}`
          && item.transportScope !== null
          && item.socketAuthScope === item.transportScope);
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          authenticatedRest: authenticatedRest.length,
          authenticatedSockets: authenticatedSockets.length,
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/desktop/discovery') {
        response.writeHead(200, cors);
        if (mode === 'malformed') {
          response.end('{"product":"ProPR"}');
          return;
        }
        if (mode === 'oversized') {
          response.end(`{"ignored":"${'x'.repeat(9 * 1024)}"}`);
          return;
        }
        response.end(JSON.stringify({
          schemaVersion: 1,
          product: 'ProPR',
          version: '0.8.15',
          apiCompatibility: PROPR_API_COMPATIBILITY,
          uiCompatibility: PROPR_UI_COMPATIBILITY,
          canonicalEndpoint: null,
          publicInstanceIdentity: identity,
          desktopAuthentication: {
            protocolVersion: 2,
            browserPairing: true,
            instanceBearerTokens: true,
            socketIoBearerAuthentication: true,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/desktop/pairings') {
        binding = await readJson(request);
        response.writeHead(201, cors);
        response.end(JSON.stringify({
          pairingId,
          deviceSecret,
          approvalUrl: `${endpoint}/api/desktop/pairings/${pairingId}/browser`,
          expiresAt: new Date(Date.now() + (mode === 'expiry' ? 200 : 60_000)).toISOString(),
          interval: 1,
        }));
        return;
      }
      if (request.method === 'GET' && request.url === `/api/desktop/pairings/${pairingId}/browser`) {
        if (approvalReadinessDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, approvalReadinessDelayMs));
          record.approvalReadinessDelayed = true;
        }
        record.fixtureModeStable = record.fixtureMode === mode
          && record.fixtureModeGeneration === modeGeneration;
        approved = true;
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>Desktop approved</title><p>Approved</p>');
        return;
      }
      if (request.method === 'POST' && request.url === `/api/desktop/pairings/${pairingId}/poll`) {
        const body = await readJson(request);
        if (body.deviceSecret !== deviceSecret || !approved || !binding) throw new Error('pairing not approved');
        if (mode === 'cancel' || mode === 'expiry') {
          response.writeHead(202, cors);
          response.end('{"status":"pending","interval":1}');
          return;
        }
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          status: 'provisional', token, tokenType: 'Bearer', activationTicket,
          activationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          instanceId: binding.instanceId,
          origin: binding.origin,
          scope: binding.scope,
          credentialGeneration: binding.credentialGeneration,
        }));
        return;
      }
      if (request.method === 'POST' && request.url === `/api/desktop/pairings/${pairingId}/activate`) {
        const body = await readJson(request);
        if (!approved || !binding || mode !== 'success'
          || body.deviceSecret !== deviceSecret || body.activationTicket !== activationTicket) {
          throw new Error('activation binding rejected');
        }
        active = true;
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          status: 'active', receipt, activatedAt: new Date().toISOString(), expiresAt: null,
        }));
        return;
      }
      if (request.method === 'DELETE' && request.url === '/api/desktop/tokens/current') {
        active = false;
        response.writeHead(204, cors);
        response.end();
        return;
      }
      if (request.url?.split('?')[0] === '/api/auth/user') {
        const expected = request.method === 'GET' && (
          request.url === '/api/auth/user?desktop_account_confirmation=1'
          || request.url === '/api/auth/user'
          || isExpectedCurrentUserRequest(request)
        );
        // Identity/admission requests must never fall through to the generic GET stub.
        if (!expected || !active || record.authorization !== `Bearer ${token}`
          || record.transportScope !== null || request.headers.cookie) {
          response.writeHead(401, cors);
          response.end('{"code":"INVALID_INSTANCE_TOKEN"}');
          return;
        }
        record.accountAccepted = true;
        response.writeHead(200, cors);
        response.end(JSON.stringify({
          ...PACKAGED_CONNECT_ACCOUNT, login: PACKAGED_CONNECT_ACCOUNT.username,
          displayName: 'Packaged Owner', email: null,
          role: 'admin', permissions: [], authorizationSource: 'bootstrap',
        }));
        return;
      }
      if (request.method === 'GET' && record.authorization === `Bearer ${token}`) {
        response.writeHead(200, cors);
        response.end('{}');
        return;
      }
    } catch {
      response.writeHead(400, cors);
      response.end('{"code":"INVALID_SMOKE_REQUEST"}');
      return;
    }
    response.writeHead(401, cors);
    response.end('{"code":"INVALID_INSTANCE_TOKEN"}');
  });
  const io = new SocketIOServer(server, {
    path: '/socket.io/',
    transports: ['websocket'],
    cors: { origin: DESKTOP_RENDERER_ORIGIN, credentials: false },
  });
  io.of('/').use((socket, next) => {
    const scopes = new URL(socket.handshake.url, 'http://fixture.invalid')
      .searchParams.getAll(DESKTOP_TRANSPORT_SCOPE_QUERY);
    const accepted = active
      && socket.handshake.headers.authorization === `Bearer ${token}`
      && scopes.length === 1
      && socket.handshake.auth?.[DESKTOP_TRANSPORT_SCOPE_QUERY] === scopes[0];
    requests.push({
      method: 'SOCKET.IO',
      url: socket.handshake.url,
      authorization: socket.handshake.headers.authorization ?? null,
      origin: socket.handshake.headers.origin ?? null,
      transportScope: scopes[0] ?? null,
      socketQueryScopeCount: scopes.length,
      socketAuthScope: socket.handshake.auth?.[DESKTOP_TRANSPORT_SCOPE_QUERY] ?? null,
      socketIo: true,
      accepted,
    });
    if (!accepted) {
      const error = new Error('INVALID_INSTANCE_TOKEN');
      error.data = { code: 'INVALID_INSTANCE_TOKEN' };
      next(error);
      return;
    }
    next();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Packaged journey fixture did not bind');
  endpoint = `http://127.0.0.1:${address.port}`;
  const close = createIdempotentJourneyFixtureClose({
    closeSocketServer: () => io.close(),
    closeHttpServer: () => new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    }),
  });
  return {
    endpoint,
    requests,
    secrets: [deviceSecret, activationTicket, token],
    close,
  };
};
