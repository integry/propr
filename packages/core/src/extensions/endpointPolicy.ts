import { compileEgressAllowlist, normalizeEgressHost } from '../network/egressAllowlist.js';
import type { ExtensionGrantNetwork } from './extensionProfileStore.js';
import dns from 'node:dns/promises';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { isIP, BlockList, type LookupFunction } from 'node:net';
import { EXTENSION_LIMITS } from '@propr/shared';
import { isNonPublicAddress } from '../network/egressProxy.js';

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
 * A socket `lookup` that answers every query with the one vetted address, so
 * the connection can only be made to it. Node asks with `all: true` (and then
 * expects a list) whenever it may race address families, which is the default
 * for named hosts since Node 20; answering that with a single address fails
 * every request with ERR_INVALID_IP_ADDRESS.
 */
export function pinnedLookup(address: string, family: number): LookupFunction {
  return (_host, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
export type ExtensionLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export interface ExtensionEndpointPolicy { network?: ExtensionGrantNetwork; internalAddresses?: string[]; onDecision?: (host: string, allowed: boolean) => Promise<void> }
export async function resolveExtensionEndpoint(value: string, lookup: ExtensionLookup = host => dns.lookup(host, { all: true, verbatim: true }), policy: ExtensionEndpointPolicy = {}): Promise<{ url: URL; address: string; family: number }> {
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
  return { url, ...addresses[0] };
}
/** An upstream session's keep-alive connection, pinned to the address vetted when the session opened. */
export interface ExtensionPinnedConnection { address: string; family: number; agent: https.Agent }
/** How long an idle pinned socket stays open; the upstream may close it sooner. */
const PINNED_SOCKET_IDLE_MS = 60_000;
/** How long a settled response may keep the pinned socket before it is ended, so the session's next request can proceed. */
const PINNED_RELEASE_GRACE_MS = 1_000;
export function extensionPinnedConnection(address: string, family: number): ExtensionPinnedConnection {
  // One socket: servers with sticky sessions lose the session on a new connection.
  return { address, family, agent: new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: PINNED_SOCKET_IDLE_MS, lookup: pinnedLookup(address, family) }) };
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
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r\n|\r|\n/); buffer = lines.pop() ?? '';
      for (const text of lines) line(text);
      return messages.splice(0);
    },
    end(): unknown[] { buffer += decoder.end(); if (buffer) line(buffer); line(''); return messages.splice(0); },
  };
}

/** Resolve on every request, dial only the checked address, keep original TLS
 * identity. No redirect, proxy environment, cookies, content decompression or
 * upstream response headers other than `Mcp-Session-Id` cross this boundary.
 * Responses may be `application/json` or `text/event-stream`; on a stream,
 * notifications are dropped and server-to-client requests are reported to
 * `exchange.onServerRequest`, never returned. */
// eslint-disable-next-line max-params -- one transport boundary for JSON, event streams, sessions and DELETE
export async function requestExtensionMcp(endpoint: string, body: unknown, token?: string, policy: ExtensionEndpointPolicy = {}, exchange: ExtensionMcpExchange = {}): Promise<unknown> {
  const { url, address, family } = await resolveExtensionEndpoint(endpoint, undefined, policy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A session keeps dialing the address vetted when it opened; the policy check above still runs on every request.
  if (exchange.pin && !exchange.connection) exchange.connection = extensionPinnedConnection(address, family);
  const dial = exchange.connection ?? { address, family };
  // Construct the transport destination solely from the vetted address. The
  // original endpoint supplies only the path, HTTP Host and TLS identity.
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
    const unavailable = () => fail(new Error('MCP connection failed'));
    const request = https.request(destination, {
      method: remove ? 'DELETE' : 'POST', agent: exchange.connection?.agent ?? false,
      servername: isIP(host) ? undefined : host,
      lookup: pinnedLookup(dial.address, dial.family),
      headers: {
        Host: url.host, ...(remove ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': exchange.protocolVersion ?? '2025-03-26', ...exchange.headers,
        ...(exchange.sessionId ? { 'Mcp-Session-Id': exchange.sessionId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
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
      const discard = () => { if (exchange.connection) release(); else response.destroy(); };
      if (remove) { discard(); finish(null); return; }
      if (response.statusCode === 401 && token) { discard(); fail(new ExtensionUpstreamUnauthorizedError()); return; }
      if (response.statusCode === 404 && exchange.sessionId) { discard(); fail(new ExtensionUpstreamSessionNotFoundError()); return; }
      const assigned = response.headers?.['mcp-session-id'];
      if (typeof assigned === 'string' && SESSION_ID.test(assigned)) exchange.assignedSessionId = assigned;
      if (response.statusCode === 202 || response.statusCode === 204) { discard(); finish(null); return; }
      const type = response.headers?.['content-type'] ?? '';
      const stream = type.startsWith('text/event-stream');
      if (response.statusCode !== 200 || !(stream || type.startsWith('application/json'))) { discard(); unavailable(); return; }
      const chunks: Buffer[] = []; let bytes = 0; let reply: object | undefined;
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
        // The call's own response ends the exchange, even if the stream stays open.
        if (reply && !settled) { responseWireBytes.set(reply, bytes); finish(reply); discard(); }
      };
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > EXTENSION_LIMITS.responseBytes) { response.destroy(); unavailable(); return; }
        if (events) accept(events.push(chunk)); else chunks.push(chunk);
      });
      response.on('error', unavailable);
      response.on('end', () => {
        if (events) {
          accept(events.end());
          if (!reply) unavailable();
          return;
        }
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed !== null && typeof parsed === 'object') responseWireBytes.set(parsed, bytes); finish(parsed); } catch { unavailable(); }
      });
    });
    const timer = setTimeout(() => { request.destroy(); unavailable(); }, EXTENSION_LIMITS.timeoutMs);
    request.on('close', () => { clearTimeout(timer); unavailable(); }); request.on('error', unavailable); request.end(payload);
  });
}
