import { createHash } from 'node:crypto';
import { EXTENSION_LIMITS } from '@propr/shared';
import logger from '../utils/logger.js';
import { ExtensionUpstreamUnauthorizedError, requestExtensionMcp, type ExtensionMcpExchange, type ExtensionMcpSend, type ExtensionPinnedConnection } from './endpointPolicy.js';

/**
 * Upstream MCP sessions of URL servers, owned by the gateway.
 *
 * The gateway opens the upstream session itself (`initialize`, then the
 * initialized notification) and keeps the returned `Mcp-Session-Id` here, keyed
 * by (run grant, server). The agent never sees it: agent-facing responses are
 * built from the result alone. Sessions never outlive the grant; they are
 * capped per grant and in total and expire when idle. The stateless
 * 2026-07-28 revision (`server/discover`) needs no session, and the gateway
 * picks it only from the upstream's answers, never from configuration.
 */

export const MCP_2026_REVISION = '2026-07-28';
/** The 2025-era revisions the gateway speaks, newest first; it asks for the newest. */
export const MCP_2025_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const UPSTREAM_SESSION_LIMITS = { perGrant: EXTENSION_LIMITS.servers, total: 256, idleMs: 10 * 60 * 1000, sweepMs: 15_000 };

export type UpstreamSessionMode = 'stateful' | 'stateless';
export interface UpstreamSessionState {
  mode: UpstreamSessionMode;
  era: '2025' | '2026';
  protocolVersion: string;
  /** The upstream `Mcp-Session-Id`; only a stateful session has one. */
  id?: string;
  connection?: ExtensionPinnedConnection;
}
export type UpstreamAuthentication = 'none' | 'bearer' | 'oauth';
type Post = (body: unknown, exchange: ExtensionMcpExchange) => Promise<unknown>;

/** `_meta` every request carries on the 2026-07-28 revision. */
export const MCP_2026_META = { 'io.modelcontextprotocol/protocolVersion': MCP_2026_REVISION, 'io.modelcontextprotocol/clientCapabilities': {} };

const resultOf = (reply: unknown): Record<string, unknown> | undefined => {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return undefined;
  const rpc = reply as Record<string, unknown>;
  if (rpc.jsonrpc !== '2.0' || Object.hasOwn(rpc, 'error') || !rpc.result || typeof rpc.result !== 'object' || Array.isArray(rpc.result)) return undefined;
  return rpc.result as Record<string, unknown>;
};
const isUnauthorized = (error: unknown) => error instanceof ExtensionUpstreamUnauthorizedError;

/** Headers and body for one request inside an upstream session. */
export function sessionRequest(state: UpstreamSessionState | undefined, body: Record<string, unknown>): { body: Record<string, unknown>; exchange: ExtensionMcpExchange } {
  if (!state) return { body, exchange: {} };
  const exchange: ExtensionMcpExchange = { protocolVersion: state.protocolVersion, ...(state.id ? { sessionId: state.id } : {}), ...(state.connection ? { connection: state.connection } : {}) };
  if (state.era !== '2026') return { body, exchange };
  const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
  const meta = params._meta && typeof params._meta === 'object' ? params._meta as Record<string, unknown> : {};
  const name: Record<string, string> = body.method === 'tools/call' && typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {};
  return {
    body: { ...body, params: { ...params, _meta: { ...meta, ...MCP_2026_META } } },
    exchange: { ...exchange, headers: { 'Mcp-Method': String(body.method), ...name } },
  };
}

export interface HandshakeOutcome {
  /** The session to keep; undefined when the upstream completed neither handshake (calls then go without a session). */
  state?: UpstreamSessionState;
  /** The upstream's answer to `initialize`, for an agent `initialize` that triggered the handshake. */
  reply?: unknown;
  /** Bytes the handshake sent. */
  requestBytes: number;
}

/**
 * The upstream refused the credential partway through a handshake. A session
 * the upstream already assigned travels with the error, so the caller keeps
 * owning it: it resumes the handshake with a refreshed credential, or closes it.
 */
export class ExtensionUpstreamHandshakeUnauthorizedError extends ExtensionUpstreamUnauthorizedError {
  constructor(readonly pending: HandshakeOutcome & { state: UpstreamSessionState }) { super(); }
}

/**
 * Open an upstream session: `initialize` (2025 era; stateful when the upstream
 * assigns an `Mcp-Session-Id`), otherwise `server/discover` (2026-07-28, stateless).
 * A refused credential propagates so an OAuth server can refresh and retry;
 * every connection opened for an abandoned handshake is closed first. Given
 * `resume` (a session initialized before its credential was refused), only the
 * initialized notification is sent again, in that session.
 */
export async function openUpstreamSession(post: Post, initializeId: string | number = 'propr-gateway-initialize', resume?: HandshakeOutcome & { state: UpstreamSessionState }): Promise<HandshakeOutcome> {
  let requestBytes = 0;
  const send = async (body: unknown, exchange: ExtensionMcpExchange) => {
    requestBytes += Buffer.byteLength(JSON.stringify(body));
    try { return await post(body, exchange); }
    catch (error) { if (isUnauthorized(error)) throw error; return undefined; }
  };
  /** Send the initialized notification in `state`; a refused credential hands the session back with the error. */
  const notify = async (state: UpstreamSessionState, reply: unknown): Promise<HandshakeOutcome> => {
    const notification = sessionRequest(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
    try { await send(notification.body, notification.exchange); }
    catch (error) { throw isUnauthorized(error) ? new ExtensionUpstreamHandshakeUnauthorizedError({ state, reply, requestBytes }) : error; }
    return { state, reply, requestBytes };
  };
  if (resume) return notify(resume.state, resume.reply);
  const initialize = { jsonrpc: '2.0', id: initializeId, method: 'initialize', params: { protocolVersion: MCP_2025_REVISIONS[0], capabilities: {}, clientInfo: { name: 'propr-extension-gateway', version: '1' } } };
  const opening: ExtensionMcpExchange = { protocolVersion: MCP_2025_REVISIONS[0], pin: true };
  let reply: unknown;
  try { reply = await send(initialize, opening); }
  catch (error) { opening.connection?.agent.destroy(); throw error; }
  const initialized = resultOf(reply);
  if (initialized) {
    const offered = initialized.protocolVersion;
    const protocolVersion = MCP_2025_REVISIONS.find(version => version === offered) ?? '2025-03-26';
    const id = opening.assignedSessionId;
    const state: UpstreamSessionState = { mode: id ? 'stateful' : 'stateless', era: '2025', protocolVersion, ...(id ? { id } : {}), ...(opening.connection ? { connection: opening.connection } : {}) };
    return notify(state, reply);
  }
  opening.connection?.agent.destroy();
  const discovering: ExtensionMcpExchange = { protocolVersion: MCP_2026_REVISION, headers: { 'Mcp-Method': 'server/discover' }, pin: true };
  let discovered: Record<string, unknown> | undefined;
  try { discovered = resultOf(await send({ jsonrpc: '2.0', id: 'propr-gateway-discover', method: 'server/discover', params: { _meta: MCP_2026_META } }, discovering)); }
  catch (error) { discovering.connection?.agent.destroy(); throw error; }
  if (discovered && Array.isArray(discovered.supportedVersions) && discovered.supportedVersions.includes(MCP_2026_REVISION)) {
    return { state: { mode: 'stateless', era: '2026', protocolVersion: MCP_2026_REVISION, ...(discovering.connection ? { connection: discovering.connection } : {}) }, reply, requestBytes };
  }
  discovering.connection?.agent.destroy();
  return { reply, requestBytes };
}

const closedSessions = new WeakSet<UpstreamSessionState>();
/** End an upstream session: `DELETE` with its id (best effort), then close its pinned connection. Later calls for the same state are no-ops. */
export async function closeUpstreamSession(state: UpstreamSessionState, remove: (exchange: ExtensionMcpExchange) => Promise<unknown>): Promise<boolean> {
  if (closedSessions.has(state)) return false;
  closedSessions.add(state);
  let deleted = false;
  try {
    if (state.id) { await remove({ method: 'DELETE', sessionId: state.id, protocolVersion: state.protocolVersion, ...(state.connection ? { connection: state.connection } : {}) }); deleted = true; }
  } catch { /* best effort: the upstream expires it */ }
  finally { state.connection?.agent.destroy(); }
  return deleted;
}

export interface UpstreamSessionEntry {
  grant: string; server: string; taskId: string; authentication: UpstreamAuthentication;
  state?: UpstreamSessionState;
  opening?: Promise<HandshakeOutcome>;
  /** A session initialized before the upstream refused the credential on the initialized notification; the next handshake resumes it. */
  pending?: HandshakeOutcome & { state: UpstreamSessionState };
  lastUsed: number;
  /** Gateway calls, successful upstream tool calls, OAuth credential changes and re-initializations after a lost session. */
  calls: number; toolCalls: number; refreshes: number; reinitialized: number;
  /** Digest of the last credential used, to count OAuth refreshes without keeping the token. */
  credential?: string;
  /** Replaced on every call with the current call's transport and credential. */
  remove: (exchange: ExtensionMcpExchange) => Promise<unknown>;
  /** Whether the run grant is still active and unexpired. */
  alive: () => Promise<boolean>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export class ExtensionUpstreamSessions {
  private readonly entries = new Map<string, UpstreamSessionEntry>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly limits = UPSTREAM_SESSION_LIMITS, private readonly now: () => number = Date.now) {}

  /** The entry for (grant, server), created on first use. Over a cap, the least recently used session is closed. */
  entry(init: Pick<UpstreamSessionEntry, 'grant' | 'server' | 'taskId' | 'authentication' | 'remove' | 'alive'>): UpstreamSessionEntry {
    const key = `${init.grant}\0${init.server}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const grantEntries = [...this.entries.values()].filter(e => e.grant === init.grant);
      if (grantEntries.length >= this.limits.perGrant) void this.drop(this.leastRecent(grantEntries)!, 'capacity');
      if (this.entries.size >= this.limits.total) void this.drop(this.leastRecent([...this.entries.values()])!, 'capacity');
      entry = { ...init, lastUsed: this.now(), calls: 0, toolCalls: 0, refreshes: 0, reinitialized: 0 };
      this.entries.set(key, entry);
      this.schedule();
    }
    entry.remove = init.remove; entry.alive = init.alive; entry.lastUsed = this.now();
    return entry;
  }

  /**
   * The open session, or a new one. Concurrent callers share one handshake; a
   * failed handshake is not kept, except a session the upstream assigned before
   * refusing the credential: the entry keeps it and the next handshake resumes it.
   */
  async open(entry: UpstreamSessionEntry, handshake: (resume?: HandshakeOutcome & { state: UpstreamSessionState }) => Promise<HandshakeOutcome>): Promise<HandshakeOutcome & { own: boolean }> {
    if (entry.state) return { state: entry.state, requestBytes: 0, own: false };
    if (entry.opening) { const shared = await entry.opening; return { state: shared.state, requestBytes: 0, own: false }; }
    const resume = entry.pending; entry.pending = undefined;
    const opening = handshake(resume);
    entry.opening = opening;
    const current = () => this.entries.get(`${entry.grant}\0${entry.server}`) === entry;
    try {
      const outcome = await opening;
      if (outcome.state && current()) {
        entry.state = outcome.state;
        logger.info({ taskId: entry.taskId, server: entry.server, sessionMode: outcome.state.mode, protocolVersion: outcome.state.protocolVersion, authentication: entry.authentication, reinitialized: entry.reinitialized }, 'Opened extension URL MCP upstream session');
      } else if (outcome.state) await closeUpstreamSession(outcome.state, entry.remove);
      return { ...outcome, own: true };
    } catch (error) {
      if (error instanceof ExtensionUpstreamHandshakeUnauthorizedError) {
        if (current()) entry.pending = error.pending;
        else await closeUpstreamSession(error.pending.state, entry.remove);
      } else if (resume) await closeUpstreamSession(resume.state, entry.remove);
      throw error;
    } finally { entry.opening = undefined; }
  }

  /** The upstream lost the session: forget it without a DELETE. */
  forget(entry: UpstreamSessionEntry, state: UpstreamSessionState): void {
    if (entry.state !== state) return;
    entry.state = undefined; state.connection?.agent.destroy();
  }

  /** Count a credential change (an OAuth refresh) for this session's telemetry. */
  credentialUsed(entry: UpstreamSessionEntry, credential: string | undefined): void {
    if (!credential) return;
    const next = digest(credential);
    if (entry.credential && entry.credential !== next) entry.refreshes++;
    entry.credential = next;
  }

  async closeGrant(grant: string, reason: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter(e => e.grant === grant).map(e => this.drop(e, reason)));
  }

  /** Close sessions of ended or expired grants and idle sessions. */
  async sweep(): Promise<void> {
    const now = this.now();
    const grants = new Map<string, UpstreamSessionEntry[]>();
    for (const entry of this.entries.values()) grants.set(entry.grant, [...(grants.get(entry.grant) ?? []), entry]);
    for (const [, entries] of grants) {
      let alive = true;
      try { alive = await entries[0].alive(); } catch { /* unknown: keep until idle expiry */ }
      for (const entry of entries) if (!alive || now - entry.lastUsed > this.limits.idleMs) await this.drop(entry, alive ? 'idle' : 'grant_ended');
    }
  }

  size(): number { return this.entries.size; }
  /** Test and shutdown support: close everything. */
  async closeAll(reason = 'shutdown'): Promise<void> { await Promise.all([...this.entries.values()].map(e => this.drop(e, reason))); }
  peek(grant: string, server: string): UpstreamSessionEntry | undefined { return this.entries.get(`${grant}\0${server}`); }

  private async drop(entry: UpstreamSessionEntry, reason: string): Promise<void> {
    const key = `${entry.grant}\0${entry.server}`;
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    const state = entry.state ?? entry.pending?.state; entry.state = undefined; entry.pending = undefined;
    const deleted = state ? await closeUpstreamSession(state, entry.remove) : false;
    logger.info({ taskId: entry.taskId, server: entry.server, sessionMode: state?.mode ?? null, authentication: entry.authentication, reason, calls: entry.calls, toolCalls: entry.toolCalls, refreshes: entry.refreshes, reinitialized: entry.reinitialized, deleted }, 'Closed extension URL MCP upstream session');
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private leastRecent(entries: UpstreamSessionEntry[]): UpstreamSessionEntry | undefined {
    return entries.reduce<UpstreamSessionEntry | undefined>((oldest, e) => (!oldest || e.lastUsed < oldest.lastUsed ? e : oldest), undefined);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, this.limits.sweepMs);
    this.timer.unref();
  }
}

/** This process's upstream sessions. */
export const extensionUpstreamSessions = new ExtensionUpstreamSessions();

export interface ExtensionMcpProbe {
  /** The upstream completed a handshake (or answered `initialize`). */
  reachable: boolean;
  /** `stateful` when the upstream assigned a session; null when no handshake completed. */
  session: UpstreamSessionMode | null;
  protocolVersion: string | null;
  /** The `tools/list` reply, when asked for. */
  tools?: unknown;
}

/**
 * Settings' checks of a URL server: open a session as the gateway would,
 * optionally list tools in it, then end it. Nothing is kept. A refused
 * credential propagates.
 */
export async function probeExtensionMcp(endpoint: string, credential: string | undefined, options: { listTools?: boolean } = {}, send: ExtensionMcpSend = requestExtensionMcp): Promise<ExtensionMcpProbe> {
  const post = (body: unknown, exchange: ExtensionMcpExchange) => send(endpoint, body, credential, {}, exchange);
  let outcome: HandshakeOutcome;
  try { outcome = await openUpstreamSession(post, 1); }
  catch (error) {
    // No refresh here: end a session the upstream assigned before refusing the credential.
    if (error instanceof ExtensionUpstreamHandshakeUnauthorizedError) await closeUpstreamSession(error.pending.state, exchange => send(endpoint, null, credential, {}, exchange));
    throw error;
  }
  const { state } = outcome;
  try {
    let tools: unknown;
    if (options.listTools) {
      const request = sessionRequest(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      tools = await post(request.body, request.exchange);
    }
    return { reachable: Boolean(state) || Boolean(resultOf(outcome.reply)), session: state?.mode ?? null, protocolVersion: state?.protocolVersion ?? null, ...(options.listTools ? { tools } : {}) };
  } finally {
    if (state) await closeUpstreamSession(state, exchange => send(endpoint, null, credential, {}, exchange));
  }
}
