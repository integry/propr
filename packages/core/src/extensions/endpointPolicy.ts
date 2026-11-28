import { compileEgressAllowlist, normalizeEgressHost } from '../network/egressAllowlist.js';
import type { ExtensionGrantNetwork } from './extensionProfileStore.js';
import dns from 'node:dns/promises';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { isIP, BlockList, type LookupFunction, type Socket } from 'node:net';
import { EXTENSION_LIMITS } from '@propr/shared';
import { isNonPublicAddress } from '../network/egressProxy.js';
import { ExtensionConnectError, ExtensionDialAgent, requestStageDetail, takeConnectStart, type ExtensionDialAddress } from './happyEyeballs.js';

const responseWireBytes = new WeakMap<object, number>();
/** Internal accounting metadata; never serialized with an MCP response. */
export const extensionResponseWireBytes = (value: unknown): number | undefined => value !== null && typeof value === 'object' ? responseWireBytes.get(value) : undefined;
// Match the egress proxy: fake-IP DNS uses 198.18.0.0/15 for public names.
const additional = new BlockList();
for (const [address, prefix] of [['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]] as const) additional.addSubnet(address, prefix, 'ipv4');
additional.addSubnet('2001:db8::', 32, 'ipv6');
additional.addSubnet('fec0::', 10, 'ipv6');
additional.addSubnet('2002::', 16, 'ipv6');
additional.addSubnet('2001::', 32, 'ipv6');
additional.addAddress('168.63.129.16', 'ipv4');
/** The upstream MCP server refused the credential (HTTP 401); an OAuth server may refresh and retry once. */
export class ExtensionUpstreamUnauthorizedError extends Error { constructor() { super('MCP credential refused'); } }
/** The upstream no longer knows the session the gateway sent (HTTP 404 with `Mcp-Session-Id`). */
export class ExtensionUpstreamSessionNotFoundError extends Error { constructor() { super('MCP session not found'); } }
/** A request waited too long for its session's one connection, busy with earlier calls; it was never sent. */
export class ExtensionUpstreamSessionBusyError extends Error { constructor() { super('MCP session busy'); } }
/** A failed exchange. `reason` is short and secret-free (an HTTP status, a timeout, a socket error code), for Test connections. */
export class ExtensionUpstreamRequestError extends Error { constructor(readonly reason: string) { super('MCP connection failed'); } }
export function extensionPublicAddress(address: string): boolean {
  return !isNonPublicAddress(address) && !additional.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
export function extensionEndpoint(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid MCP endpoint'); }
  // Query parameters can be credentials; v1 accepts path-only endpoints.
  if (!value.startsWith('https://') || /[?#]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443') || value.length > 2048) throw new Error('MCP endpoints require HTTPS without credentials, query parameters or fragments');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !extensionPublicAddress(host)) throw new Error('MCP endpoint must be public');
  if (/^(localhost|.*\.localhost|.*\.local|metadata\.google\.internal)$/i.test(host)) throw new Error('MCP endpoint must be public');
  return url;
}
/**
 * A socket `lookup` that answers every query with the vetted address (or
 * addresses), so the connection can only be made to them. Node asks with `all: true` (and then
 * expects a list) whenever it may race address families, which is the default
 * for named hosts since Node 20; answering that with a single address fails
 * every request with ERR_INVALID_IP_ADDRESS.
 */
export function pinnedLookup(address: string | readonly ExtensionDialAddress[], family = 4): LookupFunction {
  const all = typeof address === 'string' ? [{ address, family }] : address.map(entry => ({ address: entry.address, family: entry.family }));
  return (_host, options, callback) => {
    if (options?.all) callback(null, all);
    else callback(null, all[0].address, all[0].family);
  };
}
export type ExtensionLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export interface ExtensionEndpointPolicy { network?: ExtensionGrantNetwork; internalAddresses?: string[]; onDecision?: (host: string, allowed: boolean) => Promise<void> }
export async function resolveExtensionEndpoint(value: string, lookup: ExtensionLookup = host => dns.lookup(host, { all: true, verbatim: true }), policy: ExtensionEndpointPolicy = {}): Promise<{ url: URL; address: string; family: number; addresses: ExtensionDialAddress[] }> {
  const url = policy.internalAddresses ? new URL(value) : extensionEndpoint(value); const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('Invalid MCP endpoint');
  if (policy.network?.mode === 'restricted' && !compileEgressAllowlist(policy.network.allow).allows(host, 443)) {
    await policy.onDecision?.(host, false); throw new Error('MCP endpoint outside run network policy');
  }
  // Node's lookup also accepts IP literals without making a DNS request. Keep
  // the dial address separate from the caller's URL for both names and IPs.
  let timer: NodeJS.Timeout | undefined;
  let addresses: Awaited<ReturnType<ExtensionLookup>>;
  try {
    addresses = await Promise.race([
      lookup(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Endpoint DNS timeout')), EXTENSION_LIMITS.timeoutMs); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
  const pinned = policy.internalAddresses?.map(normalizeEgressHost);
  const permitted = addresses.length > 0 && addresses.every(a => {
    if (pinned && !pinned.includes(normalizeEgressHost(a.address))) return false;
    if (!pinned && !extensionPublicAddress(a.address)) return false;
    // Catalog access does not override a restricted run's private-address policy.
    return policy.network?.mode !== 'restricted' || extensionPublicAddress(a.address) || compileEgressAllowlist(policy.network.instanceAllow).allows(a.address, 443);
  });
  await policy.onDecision?.(host, permitted);
  if (!permitted) throw new Error('MCP endpoint must resolve exclusively to public addresses or authorized pinned catalog addresses');
  // Every answer passed the check above, so any of them may be dialled; `address` is the resolver's first.
  const vetted = addresses.map(a => ({ address: a.address, family: a.family }));
  return { url, ...vetted[0], addresses: vetted };
}
/**
 * An upstream session's keep-alive connection, pinned to the addresses vetted when the session opened. The first
 * connection tries them Happy Eyeballs style; `connected` is then the one that answered, and every later connection
 * of the session dials only it.
 */
export interface ExtensionPinnedConnection { addresses: readonly ExtensionDialAddress[]; connected?: ExtensionDialAddress; agent: https.Agent }
/** The addresses a connection dials: the one that connected, once one has. */
export const pinnedDialAddresses = (connection: ExtensionPinnedConnection): readonly ExtensionDialAddress[] => connection.connected ? [connection.connected] : connection.addresses;
/** How long an idle pinned socket stays open; the upstream may close it sooner. */
const PINNED_SOCKET_IDLE_MS = 60_000;
/** How long a settled response may keep the pinned socket before it is ended, so the session's next request can proceed. */
const PINNED_RELEASE_GRACE_MS = 1_000;
/**
 * How long a request may wait for a connection of its pinned agent. The request timeout (`EXTENSION_LIMITS.timeoutMs`)
 * starts only once a connection is assigned, so calls queued behind a long call in a one-connection session are not
 * timed out by their wait; past this bound they fail with `ExtensionUpstreamSessionBusyError`, unsent.
 */
export const PINNED_QUEUE_WAIT_MS = 30_000;
/** Idle keep-alive connections a stateless upstream's pool keeps; it opens as many as there are concurrent calls (a grant admits four). */
const PINNED_POOL_FREE_SOCKETS = 4;
/**
 * `session`: one socket, since servers with sticky sessions lose the session on a new connection; concurrent calls in
 * the session queue for it. `pool`: a stateless upstream, whose concurrent calls proceed in parallel.
 */
export function extensionPinnedConnection(addresses: readonly ExtensionDialAddress[], sharing: 'session' | 'pool' = 'session'): ExtensionPinnedConnection {
  const sockets = sharing === 'session' ? { maxSockets: 1, maxFreeSockets: 1 } : { maxFreeSockets: PINNED_POOL_FREE_SOCKETS };
  const connection: ExtensionPinnedConnection = { addresses: [...addresses], agent: undefined as unknown as https.Agent };
  connection.agent = new ExtensionDialAgent(() => pinnedDialAddresses(connection), EXTENSION_LIMITS.timeoutMs, address => { connection.connected ??= address; },
    { keepAlive: true, ...sockets, timeout: PINNED_SOCKET_IDLE_MS });
  return connection;
}
/**
 * Gateway-side session state for one upstream request. Nothing here reaches
 * the agent: the session id stays in Core and upstream response headers are
 * read only for `Mcp-Session-Id`.
 */
export interface ExtensionMcpExchange {
  sessionId?: string;
  /** The `MCP-Protocol-Version` header; the legacy 2025-03-26 when omitted. */
  protocolVersion?: string;
  /** Additional MCP request headers (the 2026-07-28 revision's `Mcp-Method` and `Mcp-Name`). */
  headers?: Record<string, string>;
  /** Dial through this session's pinned connection instead of a fresh one. */
  connection?: ExtensionPinnedConnection;
  /** Open a pinned connection for a session being established; the transport sets `connection`. */
  pin?: boolean;
  /** `DELETE` ends the upstream session: no body, any status. */
  method?: 'POST' | 'DELETE';
  /** Response bytes this exchange may read, at most `EXTENSION_LIMITS.responseBytes`: a gateway call's exchanges share one reservation. */
  maxBytes?: number;
  /**
   * Every response body chunk read from the upstream, whether the exchange later succeeds or fails, including a
   * drained error body. Returning false (the shared reservation is spent) ends the response and fails the exchange.
   */
  onResponseBytes?: (bytes: number) => boolean;
  /** Set by the transport: the `Mcp-Session-Id` the upstream assigned. */
  assignedSessionId?: string;
  /** A server-to-client request arrived on the response stream. It is never relayed to the agent. */
  onServerRequest?: (id: string | number) => void;
}
// eslint-disable-next-line max-params -- the transport signature: endpoint, body, credential, policy and session exchange
export type ExtensionMcpSend = (endpoint: string, body: unknown, token?: string, policy?: ExtensionEndpointPolicy, exchange?: ExtensionMcpExchange) => Promise<unknown>;
/** Visible ASCII only, bounded: a session id is a header value the gateway sends back. */
const SESSION_ID = /^[\x21-\x7e]{1,1024}$/;

/** Feeds `text/event-stream` bytes and returns the JSON-RPC messages of each complete event. */
function eventStreamParser() {
  const decoder = new StringDecoder('utf8');
  let buffer = ''; let data: string[] = [];
  /** The last chunk ended with a CR: a leading LF in the next one completes that CRLF, not an empty line. */
  let carriageReturn = false;
  const messages: unknown[] = [];
  const line = (text: string) => {
    if (text === '') {
      if (data.length) { try { messages.push(JSON.parse(data.join('\n'))); } catch { /* not JSON-RPC: ignored */ } }
      data = []; return;
    }
    if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    // `event:`, `id:`, `retry:` and comments carry nothing the gateway uses.
  };
  return {
    push(chunk: Buffer): unknown[] {
      let text = decoder.write(chunk);
      if (carriageReturn && text) { carriageReturn = false; if (text.startsWith('\n')) text = text.slice(1); }
      buffer += text;
      if (buffer.endsWith('\r')) carriageReturn = true;
      const lines = buffer.split(/\r\n|\r|\n/); buffer = lines.pop() ?? '';
      for (const text of lines) line(text);
      return messages.splice(0);
    },
    end(): unknown[] { buffer += decoder.end(); if (buffer) line(buffer); line(''); return messages.splice(0); },
  };
}

/** Fixed endpoint-check messages of {@link resolveExtensionEndpoint}: they name no host, address or credential. */
const ENDPOINT_REASONS: Record<string, string> = {
  'Invalid MCP endpoint': 'invalid endpoint', 'MCP endpoint outside run network policy': 'endpoint outside the run network policy', 'Endpoint DNS timeout': 'DNS timeout',
  'MCP endpoint must resolve exclusively to public addresses or authorized pinned catalog addresses': 'endpoint resolves to a non-public address', 'MCP request too large': 'request too large',
  'MCP endpoint must be public': 'endpoint is not public', 'MCP endpoints require HTTPS without credentials, query parameters or fragments': 'invalid endpoint',
};
/** A short, secret-free reason for a failed request: never an upstream body, header, host or token. */
export function extensionRequestFailureReason(error: unknown): string {
  if (error instanceof ExtensionUpstreamRequestError) return error.reason;
  if (error instanceof ExtensionConnectError) return error.reason;
  if (error instanceof ExtensionUpstreamUnauthorizedError) return 'credential refused (HTTP 401)';
  if (error instanceof ExtensionUpstreamSessionNotFoundError) return 'session not found (HTTP 404)';
  if (error instanceof ExtensionUpstreamSessionBusyError) return 'session busy';
  if (error instanceof Error && Object.hasOwn(ENDPOINT_REASONS, error.message)) return ENDPOINT_REASONS[error.message];
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // DNS failures (ENOTFOUND, EAI_AGAIN) come from the endpoint lookup.
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? `request failed (${code})` : 'request failed';
}

/** Resolve on every request, dial only the checked address, keep original TLS
 * identity. No redirect, proxy environment, cookies, content decompression or
 * upstream response headers other than `Mcp-Session-Id` cross this boundary.
 * Responses may be `application/json` or `text/event-stream`; on a stream,
 * notifications are dropped and server-to-client requests are reported to
 * `exchange.onServerRequest`, never returned. */
// eslint-disable-next-line max-params -- one transport boundary for JSON, event streams, sessions and DELETE
export async function requestExtensionMcp(endpoint: string, body: unknown, token?: string, policy: ExtensionEndpointPolicy = {}, exchange: ExtensionMcpExchange = {}): Promise<unknown> {
  const { url, addresses } = await resolveExtensionEndpoint(endpoint, undefined, policy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A session keeps dialing the addresses vetted when it opened (once one connects, only that one); the policy check
  // above still runs on every request.
  if (exchange.pin && !exchange.connection) exchange.connection = extensionPinnedConnection(addresses);
  const targets = exchange.connection ? pinnedDialAddresses(exchange.connection) : addresses;
  // Construct the transport destination solely from vetted addresses: the agent dials them, Happy Eyeballs style.
  // The original endpoint supplies only the path, HTTP Host and TLS identity.
  const dial = targets[0];
  const destination = new URL(`https://${dial.family === 6 ? `[${dial.address}]` : dial.address}`);
  destination.pathname = url.pathname;
  const remove = exchange.method === 'DELETE';
  const payload = remove ? '' : JSON.stringify(body);
  if (Buffer.byteLength(payload) > 64 * 1024) throw new Error('MCP request too large');
  const requestId = !remove && body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: unknown) => { if (!settled) { settled = true; resolve(value); } };
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const unavailable = (reason: string) => fail(new ExtensionUpstreamRequestError(reason));
    let timer: NodeJS.Timeout | undefined;
    let assignedSocket: Socket | undefined; let responded = false;
    const request = https.request(destination, {
      method: remove ? 'DELETE' : 'POST', agent: exchange.connection?.agent ?? new ExtensionDialAgent(() => addresses, EXTENSION_LIMITS.timeoutMs),
      servername: isIP(host) ? undefined : host,
      lookup: pinnedLookup(targets),
      headers: {
        Host: url.host, ...(remove ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': exchange.protocolVersion ?? '2025-03-26', ...exchange.headers,
        ...(exchange.sessionId ? { 'Mcp-Session-Id': exchange.sessionId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
      responded = true;
      const limit = Math.min(EXTENSION_LIMITS.responseBytes, exchange.maxBytes ?? EXTENSION_LIMITS.responseBytes);
      let bytes = 0;
      /** Charge a chunk read from the upstream; past this exchange's limit or the shared reservation, the response is ended. */
      const meter = (chunk: Buffer): boolean => {
        bytes += chunk.length;
        const within = (exchange.onResponseBytes?.(chunk.length) ?? true) && bytes <= limit;
        if (!within) { response.destroy(); unavailable('response too large'); }
        return within;
      };
      // A settled exchange hands the pinned socket back: drain the rest of the response so the socket (and a sticky
      // session) survives, but end a response the upstream keeps open after a short grace. Its socket is then
      // replaced by a new one to the same vetted address; an upstream that binds sessions to connections answers
      // the next request with 404, which the gateway's session recovery handles.
      const release = () => {
        clearTimeout(timer);
        if (response.complete) return;
        response.resume();
        const grace = setTimeout(() => response.destroy(), PINNED_RELEASE_GRACE_MS);
        const ended = () => clearTimeout(grace);
        response.once('end', ended); response.once('close', ended);
      };
      const discard = () => {
        if (!exchange.connection) { response.destroy(); return; }
        // A drained body is read from the upstream too: it is metered like any other.
        if (!metered) response.on('data', meter);
        release();
      };
      /** The 200 path below attaches its own metering listener. */
      let metered = false;
      if (remove) { discard(); finish(null); return; }
      if (response.statusCode === 401 && token) { discard(); fail(new ExtensionUpstreamUnauthorizedError()); return; }
      if (response.statusCode === 404 && exchange.sessionId) { discard(); fail(new ExtensionUpstreamSessionNotFoundError()); return; }
      const assigned = response.headers?.['mcp-session-id'];
      if (typeof assigned === 'string' && SESSION_ID.test(assigned)) exchange.assignedSessionId = assigned;
      if (response.statusCode === 202 || response.statusCode === 204) { discard(); finish(null); return; }
      const type = response.headers?.['content-type'] ?? '';
      const stream = type.startsWith('text/event-stream');
      if (response.statusCode !== 200 || !(stream || type.startsWith('application/json'))) { discard(); unavailable(response.statusCode !== 200 ? `HTTP ${response.statusCode}` : 'HTTP 200 without a JSON or event-stream body'); return; }
      const chunks: Buffer[] = []; let reply: object | undefined;
      const events = stream ? eventStreamParser() : undefined;
      const accept = (messages: unknown[]) => {
        for (const message of messages) {
          if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
          const rpc = message as Record<string, unknown>;
          if (typeof rpc.method === 'string') {
            // Sampling, elicitation and roots stay unsupported; notifications are dropped.
            if (typeof rpc.id === 'string' || typeof rpc.id === 'number') exchange.onServerRequest?.(rpc.id);
            continue;
          }
          if (reply === undefined && rpc.id === requestId) reply = rpc;
        }
        // The call's own response ends the exchange. The stream may still end cleanly (keeping a pinned socket), but
        // nothing more is read from it: an event after the response ends it instead of being drained unaccounted.
        if (reply && !settled) { responseWireBytes.set(reply, bytes); finish(reply); discard(); }
      };
      metered = true;
      response.on('data', (chunk: Buffer) => {
        if (reply) { meter(chunk); response.destroy(); return; }
        if (!meter(chunk)) return;
        if (events) accept(events.push(chunk)); else chunks.push(chunk);
      });
      response.on('error', () => unavailable('response interrupted'));
      response.on('end', () => {
        if (events) {
          accept(events.end());
          if (!reply) unavailable('event stream ended without a reply');
          return;
        }
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed !== null && typeof parsed === 'object') responseWireBytes.set(parsed, bytes); finish(parsed); } catch { unavailable('invalid JSON response'); }
      });
    });
    // The request timeout runs from the moment a connection is assigned; before that the request is queued on its
    // pinned agent behind earlier calls (a fresh connection is assigned at once) and has its own bounded wait.
    const queued = setTimeout(() => { request.destroy(); fail(new ExtensionUpstreamSessionBusyError()); }, PINNED_QUEUE_WAIT_MS);
    // A connection opened for this request already spent part of the budget connecting; the rest is the request's.
    request.once('socket', socket => {
      clearTimeout(queued); assignedSocket = socket;
      const connecting = takeConnectStart(socket);
      const budget = connecting === undefined ? EXTENSION_LIMITS.timeoutMs : Math.max(EXTENSION_LIMITS.timeoutMs - (Date.now() - connecting), 0);
      if (!settled) timer = setTimeout(() => { unavailable(`timeout after ${EXTENSION_LIMITS.timeoutMs / 1000} s (${requestStageDetail(assignedSocket, responded)})`); request.destroy(); }, budget);
    });
    request.on('close', () => { clearTimeout(queued); clearTimeout(timer); unavailable('connection closed'); });
    request.on('error', (error: NodeJS.ErrnoException) => error instanceof ExtensionConnectError ? unavailable(error.reason) : unavailable(typeof error.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code) ? `connection failed (${error.code})` : 'connection failed'));
    request.end(payload);
  });
}
