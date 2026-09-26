import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY,
  DESKTOP_TOKEN_REVOCATION_ENDPOINT, DESKTOP_TOKEN_REVOCATION_SCHEMA,
  DESKTOP_TOKEN_REVOCATION_VERSION, DESKTOP_REVOCATION_BINDING_HEADER,
} from '@propr/shared';

// Synthetic identities and credentials only. All traffic stays on loopback.
export const accounts = [
  { id: '101', username: 'alice', avatarUrl: null },
  { id: '202', username: 'bob', avatarUrl: null },
];
export async function createTwoAccountFixture() {
  const users = new Map();
  const pairings = new Map();
  const revoked = new Set();
  const requests = [];
  const delayed = new Map();
  let nextAccount = accounts[0];
  let offline = false;
  let endpoint;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, endpoint).pathname;
    const token = request.headers.authorization?.replace('Bearer ', '');
    requests.push({ path, token });
    const json = (body, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*' });
      response.end(JSON.stringify(body));
    };
    if (offline) { request.socket.destroy(); return; }
    if (request.method === 'OPTIONS') { json({}); return; }
    if (path === '/api/desktop/discovery') return json({
      schemaVersion: 1, product: 'ProPR', version: '0.8.15', apiCompatibility: PROPR_API_COMPATIBILITY,
      uiCompatibility: PROPR_UI_COMPATIBILITY, canonicalEndpoint: null,
      publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
      desktopAuthentication: { protocolVersion: 2, browserPairing: true, instanceBearerTokens: true, socketIoBearerAuthentication: true },
    });
    if (path === '/api/desktop/pairings') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const binding = JSON.parse(Buffer.concat(chunks).toString());
      const n = pairings.size + 1;
      const pairingId = `dpr_${String(n).padStart(22, 'P')}`;
      const bearer = `propr_it_${String(n).padStart(43, 'T')}`;
      users.set(bearer, nextAccount);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      pairings.set(pairingId, { instanceId: binding.instanceId, origin: binding.origin, scope: binding.scope,
        credentialGeneration: binding.credentialGeneration, token: bearer, activationExpiresAt: expiresAt });
      return json({ pairingId, deviceSecret: 'D'.repeat(43), approvalUrl: `${endpoint}/approve`, expiresAt, interval: 1 }, 201);
    }
    if (path.endsWith('/poll')) return json({ status: 'provisional', tokenType: 'Bearer', activationTicket: 'A'.repeat(43), ...pairings.get(path.split('/')[4]) });
    if (path.endsWith('/activate')) return json({ status: 'active', receipt: 'R'.repeat(22), activatedAt: new Date().toISOString(), expiresAt: null });
    if (path.endsWith('/cancel')) {
      revoked.add(pairings.get(path.split('/')[4])?.token);
      return json({ status: 'cancelled', cancelledAt: new Date().toISOString() });
    }
    if (path === DESKTOP_TOKEN_REVOCATION_ENDPOINT) {
      revoked.add(token);
      return json({ schema: DESKTOP_TOKEN_REVOCATION_SCHEMA, version: DESKTOP_TOKEN_REVOCATION_VERSION,
        endpoint: path, terminal: true, code: 'INSTANCE_TOKEN_REVOKED',
        credentialGeneration: request.headers[DESKTOP_REVOCATION_BINDING_HEADER.toLowerCase()],
      }, 401);
    }
    if (!users.has(token) || revoked.has(token)) return json({ code: 'INVALID_INSTANCE_TOKEN' }, 401);
    if (path === '/api/late-rest') { delayed.set(path, () => json(users.get(token))); return; }
    if (path === '/api/late-body') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.write(' ');
      delayed.set(path, () => response.end(JSON.stringify(users.get(token))));
      return;
    }
    return json(users.get(token));
  });
  const io = new Server(server, { cors: { origin: '*' } });
  io.use((socket, next) => {
    const token = socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (offline || !users.has(token) || revoked.has(token)) return next(new Error('unauthorized'));
    socket.data.account = users.get(token);
    next();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  return { endpoint, io, users, revoked, requests, delayed,
    account: account => { nextAccount = account; },
    offline: value => { offline = value; },
    release: () => { for (const finish of delayed.values()) finish(); delayed.clear(); },
    close: async () => {
      for (const finish of delayed.values()) finish();
      await new Promise(resolve => { io.close(resolve); server.closeAllConnections(); });
    },
  };
}
