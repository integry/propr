#!/usr/bin/env node
// A minimal OAuth 2.1 authorization server and OAuth-protected, stateful MCP
// endpoint for the Fly smoke's extensions mode. No dependencies: it runs on a
// disposable Sprite behind its public HTTPS URL.
//
// - Protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).
// - Dynamic client registration (RFC 7591), authorization code with PKCE S256,
//   the `resource` indicator, an auto-approving consent and rotating refresh tokens.
// - Access tokens live ACCESS_TTL seconds (default 90): with Core's one-minute
//   refresh margin, a run that lasts a few minutes refreshes mid-run.
// - `/mcp`: 2025-era MCP with `Mcp-Session-Id` sessions and one deterministic
//   `echo` tool (argument `message`). Unknown sessions get 404, as the spec says.
// - `/stats`: counters only (refreshes, sessions, calls), no tokens.
//
// State is written to STATE_FILE after each change, so a Sprite that sleeps
// and restarts keeps registrations and tokens. MCP sessions are kept too.
//
// Env: PUBLIC_URL (https origin, required), PORT (8080), ACCESS_TTL (90), STATE_FILE.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const origin = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(origin)) { console.error('PUBLIC_URL must be an https origin'); process.exit(2); }
const port = Number(process.env.PORT ?? 8080);
const accessTtl = Number(process.env.ACCESS_TTL ?? 90);
const stateFile = process.env.STATE_FILE ?? `${process.env.HOME ?? '/tmp'}/oauth-mcp-fixture.json`;
const resource = `${origin}/mcp`;
const random = prefix => `${prefix}_${randomBytes(24).toString('base64url')}`;

const empty = () => ({ clients: {}, codes: {}, access: {}, refresh: {}, sessions: {}, stats: { registrations: 0, authorizations: 0, codeExchanges: 0, refreshes: 0, unauthorized: 0, sessionsOpened: 0, sessionsDeleted: 0, sessionNotFound: 0, toolCalls: 0, echoes: [] } });
let state = empty();
try { state = { ...empty(), ...JSON.parse(readFileSync(stateFile, 'utf8')) }; } catch { /* first start */ }
const save = () => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${stateFile}.tmp`, stateFile); };

const metadata = {
  issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['echo'], authorization_response_iss_parameter_supported: true,
};
const resourceMetadata = { resource, authorization_servers: [origin], scopes_supported: ['echo'], bearer_methods_supported: ['header'] };

const send = (res, status, body, headers = {}) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }).end(text);
};
const read = req => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', chunk => { size += chunk.length; if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
});
const issue = (clientId, scope) => {
  const access = random('fixture_access'); const refresh = random('fixture_refresh');
  state.access[access] = { clientId, expiresAt: Date.now() + accessTtl * 1000 };
  state.refresh[refresh] = { clientId, scope };
  return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, scope };
};
const challenge = res => { state.stats.unauthorized++; save(); send(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="echo"` }); };
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function mcp(req, res) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const access = bearer ? state.access[bearer] : undefined;
  if (!access || access.expiresAt <= Date.now()) { if (access) delete state.access[bearer]; return challenge(res); }
  const sessionId = req.headers['mcp-session-id'];
  if (req.method === 'DELETE') {
    if (sessionId && state.sessions[sessionId]) { delete state.sessions[sessionId]; state.stats.sessionsDeleted++; save(); }
    return send(res, 204);
  }
  if (req.method !== 'POST') return send(res, 405, rpcError(null, -32600, 'POST only'));
  let rpc; try { rpc = JSON.parse(await read(req)); } catch { return send(res, 400, rpcError(null, -32700, 'Parse error')); }
  if (rpc.method === 'initialize') {
    const id = `fixture-session-${randomBytes(12).toString('hex')}`;
    state.sessions[id] = { createdAt: Date.now() }; state.stats.sessionsOpened++; save();
    const offered = rpc.params?.protocolVersion;
    const protocolVersion = ['2025-11-25', '2025-06-18', '2025-03-26'].includes(offered) ? offered : '2025-06-18';
    return send(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'propr-fly-oauth-fixture', version: '1' } } }, { 'mcp-session-id': id });
  }
  if (!sessionId) return send(res, 400, rpcError(rpc.id, -32600, 'Mcp-Session-Id header is required; send initialize first'));
  if (!state.sessions[sessionId]) { state.stats.sessionNotFound++; save(); return send(res, 404, rpcError(rpc.id, -32001, 'Session not found')); }
  if (rpc.id === undefined) return send(res, 202);
  if (rpc.method === 'ping') return send(res, 200, { jsonrpc: '2.0', id: rpc.id, result: {} });
  if (rpc.method === 'tools/list') return send(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', description: 'Returns the message exactly.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] } });
  if (rpc.method === 'tools/call' && rpc.params?.name === 'echo' && typeof rpc.params.arguments?.message === 'string') {
    state.stats.toolCalls++; state.stats.echoes = [...state.stats.echoes, rpc.params.arguments.message.slice(0, 200)].slice(-20); save();
    return send(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: rpc.params.arguments.message }] } });
  }
  return send(res, 200, rpcError(rpc.id, -32601, 'Method not found'));
}

async function token(req, res) {
  const form = new URLSearchParams(await read(req));
  const client = state.clients[form.get('client_id') ?? ''];
  if (!client) return send(res, 401, { error: 'invalid_client' });
  if (form.get('resource') !== resource) return send(res, 400, { error: 'invalid_target' });
  if (form.get('grant_type') === 'authorization_code') {
    const code = state.codes[form.get('code') ?? ''];
    const verifier = form.get('code_verifier') ?? '';
    if (!code || code.used || code.clientId !== form.get('client_id') || code.redirectUri !== form.get('redirect_uri') || code.expiresAt <= Date.now()
      || createHash('sha256').update(verifier).digest('base64url') !== code.challenge) return send(res, 400, { error: 'invalid_grant' });
    code.used = true; state.stats.codeExchanges++;
    const tokens = issue(code.clientId, code.scope); save();
    return send(res, 200, tokens);
  }
  if (form.get('grant_type') === 'refresh_token') {
    const refresh = state.refresh[form.get('refresh_token') ?? ''];
    if (!refresh || refresh.clientId !== form.get('client_id')) return send(res, 400, { error: 'invalid_grant' });
    delete state.refresh[form.get('refresh_token')];
    state.stats.refreshes++;
    const tokens = issue(refresh.clientId, refresh.scope); save();
    return send(res, 200, tokens);
  }
  return send(res, 400, { error: 'unsupported_grant_type' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/stats') return send(res, 200, { ...state.stats, accessTtl, activeSessions: Object.keys(state.sessions).length });
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return send(res, 200, resourceMetadata);
    if (url.pathname === '/.well-known/oauth-authorization-server') return send(res, 200, metadata);
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await read(req) || '{}');
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(u => typeof u === 'string' && u.startsWith('https://')) : [];
      if (!redirectUris.length) return send(res, 400, { error: 'invalid_redirect_uri' });
      const clientId = random('fixture_client');
      state.clients[clientId] = { redirectUris }; state.stats.registrations++; save();
      return send(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      // Auto-approving consent: checks the request as a strict provider would, then redirects back.
      const p = url.searchParams; const client = state.clients[p.get('client_id') ?? ''];
      const redirectUri = p.get('redirect_uri') ?? '';
      if (!client || !client.redirectUris.includes(redirectUri)) return send(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect URI' });
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || p.get('resource') !== resource || !p.get('state')) return send(res, 400, { error: 'invalid_request' });
      const code = random('fixture_code');
      state.codes[code] = { clientId: p.get('client_id'), redirectUri, challenge: p.get('code_challenge'), scope: p.get('scope') ?? 'echo', used: false, expiresAt: Date.now() + 5 * 60 * 1000 };
      state.stats.authorizations++; save();
      const location = new URL(redirectUri);
      location.searchParams.set('code', code); location.searchParams.set('state', p.get('state')); location.searchParams.set('iss', origin);
      res.writeHead(302, { location: location.toString(), 'cache-control': 'no-store' }).end(); return;
    }
    if (url.pathname === '/token' && req.method === 'POST') return await token(req, res);
    if (url.pathname === '/mcp') return await mcp(req, res);
    send(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('fixture error', error instanceof Error ? error.message : 'unknown');
    if (!res.headersSent) send(res, 500, { error: 'server_error' });
  }
});
server.listen(port, '0.0.0.0', () => console.log(`OAuth MCP fixture listening on ${port} for ${origin}`));
