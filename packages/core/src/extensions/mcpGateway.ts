import { EXTENSION_LIMITS } from '@propr/shared';
import { ExtensionError, ExtensionLibraryStore, extensionTokenHash } from './extensionProfileStore.js';
import { ExtensionUpstreamSessionBusyError, ExtensionUpstreamSessionNotFoundError, ExtensionUpstreamUnauthorizedError, requestExtensionMcp, extensionResponseWireBytes, resolveExtensionEndpoint, type ExtensionMcpExchange, type ExtensionMcpSend } from './endpointPolicy.js';
import { ExtensionUpstreamHandshakeIncompleteError, ExtensionUpstreamHandshakeUnauthorizedError, ExtensionUpstreamSessionCapacityError, closeUpstreamSession, extensionUpstreamSessions, openUpstreamSession, sessionRequest, type ExtensionUpstreamSessions, type HandshakeOutcome, type UpstreamSessionState } from './mcpUpstreamSessions.js';
import { extensionOAuth } from './extensionOAuthStore.js';
import { redactExtensionOutput } from './extensionOutput.js';
export { redactExtensionOutput } from './extensionOutput.js';

/** The agent-facing `initialize` result: the same for every server, whatever the upstream negotiated. */
const initializeProjection = (name: string) => ({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name, version: '1' } });
/** An agent `initialize` answered by the gateway itself, the upstream session already open. */
const LOCAL_INITIALIZE = Symbol('local initialize');
/** Transport failures the agent should be told apart from a failed connection; anything else is 'MCP connection failed'. */
const gatewayError = (error: unknown): ExtensionError | undefined => {
  if (error instanceof ExtensionError) return error;
  if (error instanceof ExtensionUpstreamSessionBusyError) return new ExtensionError(503, 'MCP session busy: earlier calls in this session are still running; the call was not sent');
  return undefined;
};

/** Whether a run grant is still active and unexpired (not merely over its concurrency or budget limits). */
const extensionGrantAlive = async (store: ExtensionLibraryStore, grant: string) =>
  Boolean(await store.database('extension_run_grants').where({ token_hash: grant, active: true }).where('expires_at', '>', Date.now()).first());

// eslint-disable-next-line max-params, complexity -- protocol validation, policy enforcement and budget release share one gateway boundary
export async function extensionGatewayCall(store: ExtensionLibraryStore, token: string, serverName: string, body: unknown, send: ExtensionMcpSend = requestExtensionMcp, sessions: ExtensionUpstreamSessions = extensionUpstreamSessions): Promise<unknown> {
  let granted: Awaited<ReturnType<ExtensionLibraryStore['grantSnapshot']>>;
  try { granted = await store.grantSnapshot(token); }
  catch (error) {
    // An ended or expired grant takes its upstream sessions with it. The same 401 also refuses a call over the
    // grant's concurrency or budget limits while other admitted calls still use the session: close only a grant
    // that is revoked, missing or expired.
    if (error instanceof ExtensionError && error.status === 401) {
      const grant = extensionTokenHash(token);
      if (!await extensionGrantAlive(store, grant).catch(() => true)) await sessions.closeGrant(grant, 'grant_ended').catch(() => undefined);
    }
    throw error;
  }
  const { snapshot, secrets, network, allowWrite, taskId } = granted;
  // Failed/oversized requests consume the full reservation, so failures cannot
  // bypass the run budget. Successful responses charge actual wire bytes,
  // including whitespace that disappears during JSON parsing.
  let responseBytes: number = EXTENSION_LIMITS.responseBytes;
  let recordedDecision = false;
  /**
   * Response bytes this call read from the upstream, counted as the transport reads them: failed and abandoned
   * exchanges, drained bodies and server-to-client answers included. Once the call has settled its reservation,
   * a late chunk (an answer still in flight) is charged to the grant directly and ends that response.
   */
  let inbound = 0;
  let accounting = true;
  let lateCharge: ((bytes: number) => Promise<void>) | undefined;
  const meter = (bytes: number): boolean => {
    if (!accounting) { void lateCharge?.(bytes); return false; }
    inbound += bytes;
    return inbound <= EXTENSION_LIMITS.responseBytes;
  };
  let decision: { host: string; allowed: boolean } | undefined;
  /** OAuth access tokens used by this call, redacted from its output. */
  const oauthTokens: string[] = [];
  /** Upstream session ids, redacted too: a tool may echo request headers. */
  const sessionIds: string[] = [];
  /** Ends this call's use of its upstream session entry, so the entry may be evicted again. */
  let releaseSession: (() => void) | undefined;
  try {
  const server = snapshot.servers.find(s => s.enabled && s.name === serverName);
  if (!server || !body || typeof body !== 'object' || Array.isArray(body)) throw new ExtensionError(403, 'MCP capability unavailable');
  if (server.capability === 'write' && !allowWrite) throw new ExtensionError(403, 'Run write grant unavailable');
  const rpc = body as Record<string, unknown>;
  if (rpc.jsonrpc !== '2.0' || Object.keys(rpc).some(k => !['jsonrpc', 'id', 'method', 'params'].includes(k)) || !(rpc.id === undefined || typeof rpc.id === 'string' || typeof rpc.id === 'number') || !['initialize', 'ping', 'notifications/initialized', 'tools/list', 'tools/call'].includes(String(rpc.method))) throw new ExtensionError(403, 'MCP method unavailable');
  const params = rpc.params as Record<string, unknown> | undefined;
  if (rpc.method === 'tools/call' && (!params || typeof params.name !== 'string' || !server.tools.includes(params.name) || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k)))) throw new ExtensionError(403, 'MCP tool unavailable');
  // The gateway owns the upstream session (see mcpUpstreamSessions.ts): its id,
  // connection and handshake stay in Core, and nothing upstream (session ids,
  // cookies, server-to-client requests) can reach the agent or widen the grant.
  let upstream: unknown;
  const forwarded: Record<string, unknown> = rpc.method === 'tools/call' ? { ...rpc, params: { name: params!.name, ...(params!.arguments === undefined ? {} : { arguments: params!.arguments }) } } : rpc;
  if (server.kind === 'package') throw new ExtensionError(403, 'Local package tools require the selected task container');
  const entry = server.kind === 'catalog' ? await store.catalog.resolve(server.catalogId, server.digest, server.tools, server.capability) : undefined;
  if (entry?.kind === 'stdio') throw new ExtensionError(403, 'Local catalog tools require the selected task container');
  const endpoint = server.kind === 'https' ? server.url : entry!.kind === 'https' ? entry!.url : '';
  const operatorToken = entry?.kind === 'https' ? store.catalog.secrets(entry).bearerToken : undefined;
  if (operatorToken) secrets[serverName] = operatorToken;
  const recordDecision = async () => {
    if (decision && !recordedDecision) {
      await store.recordGatewayNetwork(token, decision.host, decision.allowed);
      recordedDecision = true;
    }
  };
  const transportPolicy = { network, ...(entry?.kind === 'https' ? { internalAddresses: entry.addresses } : {}) };
  const policy = { ...transportPolicy, onDecision: async (host: string, allowed: boolean) => {
    decision = { host: server.kind === 'catalog' ? `catalog:${server.catalogId}@${server.digest}` : host, allowed };
    await recordDecision();
  } };
  // Check even with an injected transport; the real transport resolves again and
  // pins the checked address immediately before TLS dialing.
  await resolveExtensionEndpoint(endpoint, undefined, { ...policy, onDecision: async (host, allowed) => {
    decision = { host: server.kind === 'catalog' ? `catalog:${server.catalogId}@${server.digest}` : host, allowed };
    // Successful prechecks are recorded by the physical transport. A denied
    // precheck never reaches that transport and must be retained here.
    if (!allowed) await recordDecision();
  } });
  // The gateway already sent the initialized notification when it opened the upstream session.
  if (rpc.method === 'notifications/initialized') { responseBytes = 0; return null; }
  const requestBytes = Buffer.byteLength(JSON.stringify(forwarded));
  await store.database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).increment('request_bytes', requestBytes);
  // OAuth servers: ask Core for the current access token on every call (a run
  // can outlive a token). Never the library secret, which is a client secret.
  const oauth = server.kind === 'https' && server.authentication === 'oauth';
  const credential = async (): Promise<string | undefined> => {
    if (!oauth) return secrets[serverName];
    try { const current = await extensionOAuth(store).accessToken(snapshot.instanceId, server); oauthTokens.push(current); return current; }
    catch { throw new ExtensionError(502, 'MCP connection failed'); }
  };
  const grant = extensionTokenHash(token);
  let latest: string | undefined;
  let session: ReturnType<ExtensionUpstreamSessions['entry']>;
  try {
    session = sessions.entry({
      grant, server: serverName, taskId, authentication: server.kind === 'https' ? server.authentication : operatorToken ? 'bearer' : 'none',
      // The DELETE at grant end needs no telemetry: the grant row may already be gone.
      remove: exchange => send(endpoint, null, latest, transportPolicy, exchange),
      alive: () => extensionGrantAlive(store, grant),
    });
  } catch (error) {
    // Every session slot has a call in flight; none is closed under it.
    if (error instanceof ExtensionUpstreamSessionCapacityError) throw new ExtensionError(503, 'MCP session capacity reached');
    throw error;
  }
  releaseSession = () => sessions.release(session);
  session.calls++;
  lateCharge = async bytes => { await store.database('extension_run_grants').where({ token_hash: grant }).increment('bytes', bytes).catch(() => undefined); };
  // Every upstream response of this call (handshakes, recovery handshakes, server-to-client answers, the call itself)
  // shares the call's one response reservation through `meter`: each exchange may read only what the others left,
  // and the call is charged the sum, failed exchanges included.
  const remaining = () => Math.max(0, EXTENSION_LIMITS.responseBytes - inbound);
  // Server-to-client requests (sampling, elicitation, roots) are answered upstream with an error and never relayed.
  // The answer uses its own connection: the pinned one is busy with the stream that waits for it.
  const answering = (used: string | undefined, exchange: ExtensionMcpExchange): ExtensionMcpExchange => {
    let answered = 0;
    exchange.onServerRequest = id => {
      if (answered++ >= 8) return;
      const answer: ExtensionMcpExchange = { maxBytes: remaining(), onResponseBytes: meter, ...(exchange.sessionId ? { sessionId: exchange.sessionId } : {}), ...(exchange.protocolVersion ? { protocolVersion: exchange.protocolVersion } : {}), ...(exchange.headers ? { headers: exchange.headers } : {}) };
      void send(endpoint, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Server-to-client requests are not supported' } }, used, transportPolicy, answer).catch(() => undefined);
    };
    return exchange;
  };
  const post = (used: string | undefined) => async (message: unknown, exchange: ExtensionMcpExchange) => {
    // The same exchange object: the transport reports the assigned session and pinned connection on it.
    exchange.maxBytes = remaining(); exchange.onResponseBytes = meter;
    return send(endpoint, message, used, policy, answering(used, exchange));
  };
  const call = async (state: UpstreamSessionState | undefined, used: string | undefined) => {
    const request = sessionRequest(state, forwarded);
    // Redact the id actually sent: a concurrent re-initialization may replace the entry's session meanwhile.
    if (request.exchange.sessionId) sessionIds.push(request.exchange.sessionId);
    let metered = false;
    const reply = await send(endpoint, request.body, used, policy, answering(used, { ...request.exchange, maxBytes: remaining(), onResponseBytes: bytes => { metered = true; return meter(bytes); } }));
    // A reply without transport accounting (an injected transport) is charged the full reservation, as before.
    if (reply !== null && !metered && extensionResponseWireBytes(reply) === undefined) inbound += EXTENSION_LIMITS.responseBytes;
    return reply;
  };
  const attempt = async (used: string | undefined): Promise<unknown> => {
    latest = used; sessions.credentialUsed(session, used);
    const handshake = async (resume?: Parameters<typeof openUpstreamSession>[2]) => {
      const charge = (bytes: number) => store.database('extension_run_grants').where({ token_hash: grant }).increment('request_bytes', bytes);
      let outcome: HandshakeOutcome;
      try { outcome = await openUpstreamSession(post(used), rpc.method === 'initialize' ? rpc.id as string | number : undefined, resume); }
      catch (error) {
        // The refused handshake's bytes were sent; its session stays with the entry for the retry.
        if (error instanceof ExtensionUpstreamHandshakeUnauthorizedError || error instanceof ExtensionUpstreamHandshakeIncompleteError) await charge(error.pending.requestBytes).catch(() => undefined);
        throw error;
      }
      try { await charge(outcome.requestBytes); }
      catch (error) { if (outcome.state) await closeUpstreamSession(outcome.state, session.remove); throw error; }
      return outcome;
    };
    let state = session.state;
    if (!state) {
      const opened = await sessions.open(session, handshake);
      // An agent `initialize` gets the fixed projection once a session is open (either era); without one,
      // the upstream's own reply to it, whose error code is preserved as before.
      if (rpc.method === 'initialize') return opened.state ? LOCAL_INITIALIZE : opened.own ? opened.reply : undefined;
      state = opened.state;
    } else if (rpc.method === 'initialize') return LOCAL_INITIALIZE;
    try { return await call(state, used); }
    catch (error) {
      if (!(error instanceof ExtensionUpstreamSessionNotFoundError) || !state) throw error;
      sessions.forget(session, state);
      // Only reads are replayed: a write may already have taken effect upstream.
      if (rpc.method === 'tools/call' && server.capability === 'write') throw new ExtensionError(502, 'MCP session expired; the write call was not replayed');
      session.reinitialized++;
      return await call((await sessions.open(session, handshake)).state, used);
    }
  };
  const used = await credential();
  try { upstream = await attempt(used); }
  catch (error) {
    const known = gatewayError(error);
    if (known) throw known;
    if (!oauth || !(error instanceof ExtensionUpstreamUnauthorizedError) || !used) throw new ExtensionError(502, 'MCP connection failed');
    // One refresh and one retry after the upstream refused the token.
    let retried: string;
    try { retried = await extensionOAuth(store).refreshAfterRejection(snapshot.instanceId, server, used); oauthTokens.push(retried); }
    catch { throw new ExtensionError(502, 'MCP connection failed'); }
    await store.database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).increment('request_bytes', requestBytes);
    try { upstream = await attempt(retried); }
    catch (retryError) { throw gatewayError(retryError) ?? new ExtensionError(502, 'MCP connection failed'); }
  }
  if (session.state?.id) sessionIds.push(session.state.id);
  const received = Math.min(EXTENSION_LIMITS.responseBytes, inbound);
  if (upstream === LOCAL_INITIALIZE) {
    responseBytes = received;
    return { jsonrpc: '2.0', id: rpc.id, result: initializeProjection(server.name) };
  }
  if (upstream === null && rpc.id === undefined) { responseBytes = received; return null; }
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) throw new ExtensionError(502, 'MCP protocol unavailable');
  responseBytes = received;
  const result = upstream as Record<string, unknown>;
  if (result.jsonrpc !== '2.0' || result.id !== rpc.id) throw new ExtensionError(502, 'MCP request failed');
  if (Object.hasOwn(result, 'error')) {
    const error = result.error as { code?: unknown; message?: unknown } | null;
    if (Object.hasOwn(result, 'result') || !error || typeof error !== 'object' || Array.isArray(error) || !Number.isSafeInteger(error.code) || typeof error.message !== 'string') throw new ExtensionError(502, 'MCP protocol unavailable');
    // Upstream messages/data are untrusted and may contain credentials or
    // operator details. Preserve only the protocol code, as the stdio bridge does.
    return { jsonrpc: '2.0', id: rpc.id, error: { code: error.code, message: 'MCP request failed' } };
  }
  if (!Object.hasOwn(result, 'result')) throw new ExtensionError(502, 'MCP request failed');
  if (rpc.method === 'tools/call') session.toolCalls++;
  let projection = result.result;
  if (rpc.method === 'initialize') {
    projection = initializeProjection(server.name);
  } else if (rpc.method === 'tools/list') {
    const tools = (projection as { tools?: unknown[] })?.tools;
    if (!Array.isArray(tools) || tools.length > 64) throw new ExtensionError(502, 'MCP tool catalog unavailable');
    projection = { tools: tools.filter(t => t && typeof t === 'object' && server.tools.includes(String((t as { name?: unknown }).name))) };
  }
  const redacted = redactExtensionOutput({ jsonrpc: '2.0', id: rpc.id, result: projection }, [...Object.values(secrets), ...oauthTokens, ...sessionIds, token]);
  if (Buffer.byteLength(JSON.stringify(redacted)) > EXTENSION_LIMITS.responseBytes) throw new ExtensionError(502, 'MCP response too large');
  return redacted;
  } finally {
    releaseSession?.();
    // Settle the charge with every byte read so far; a chunk still arriving is charged to the grant directly.
    accounting = false;
    if (responseBytes < EXTENSION_LIMITS.responseBytes) responseBytes = Math.min(EXTENSION_LIMITS.responseBytes, Math.max(responseBytes, inbound));
    // A call that read past its reservation is charged all of it; nothing after the chunk that crossed it is read.
    try { if (decision && !recordedDecision) await store.recordGatewayNetwork(token, decision.host, decision.allowed); }
    finally { await store.finishGatewayCall(token, responseBytes); }
  }
}
