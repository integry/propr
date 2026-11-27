import { createHash } from 'node:crypto';
import { EXTENSION_LIMITS } from '@propr/shared';
import logger from '../utils/logger.js';
import { ExtensionUpstreamUnauthorizedError, extensionPinnedConnection, extensionRequestFailureReason, pinnedDialAddresses, requestExtensionMcp, type ExtensionMcpExchange, type ExtensionMcpSend, type ExtensionPinnedConnection } from './endpointPolicy.js';

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
  /** Without a state: why each era's handshake failed, short and secret-free (for Test connections). */
  failure?: string;
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
 * The upstream assigned a session but did not accept the initialized
 * notification (an error status, a timeout, a dropped connection). The session
 * is not initialized, so it is never kept: the caller closes the session that
 * travels with the error, and the next call opens a new one. An upstream that
 * assigned no session is not held to this: its calls need no initialized state.
 */
export class ExtensionUpstreamHandshakeIncompleteError extends Error {
  constructor(readonly pending: HandshakeOutcome & { state: UpstreamSessionState }, readonly reason = 'initialized notification failed') { super('MCP session initialization incomplete'); }
}

/**
 * A stateless upstream keeps the address that connected at the handshake but not its one-socket connection: its concurrent
 * calls get a pool to the same address and proceed in parallel.
 */
function pooled(connection: ExtensionPinnedConnection | undefined): ExtensionPinnedConnection | undefined {
  if (!connection) return undefined;
  connection.agent.destroy();
  return extensionPinnedConnection(pinnedDialAddresses(connection), 'pool');
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
  const charged = (body: unknown, exchange: ExtensionMcpExchange) => {
    requestBytes += Buffer.byteLength(JSON.stringify(body));
    return post(body, exchange);
  };
  const failures: string[] = [];
  /** Protocol discovery: any failure but a refused credential only means this era is unavailable (its reason is kept). */
  const send = async (body: unknown, exchange: ExtensionMcpExchange) => {
    try { return await charged(body, exchange); }
    catch (error) { if (isUnauthorized(error)) throw error; failures.push(`${(body as { method: string }).method}: ${extensionRequestFailureReason(error)}`); return undefined; }
  };
  /** An answer that was not a usable result: a JSON-RPC error code, never its message. */
  const refused = (method: string, reply: unknown, unsupported: boolean) => {
    if (reply === undefined) return;
    const code = (reply as { error?: { code?: unknown } } | null)?.error?.code;
    failures.push(`${method}: ${unsupported ? 'no supported protocol version' : Number.isInteger(code) ? `JSON-RPC error ${code as number}` : 'not a JSON-RPC result'}`);
  };
  /**
   * Send the initialized notification in `state`. Only an accepted notification completes the handshake: a refused
   * credential hands the session back for a resume, and any other failure hands it back to be closed.
   */
  const notify = async (state: UpstreamSessionState, reply: unknown): Promise<HandshakeOutcome> => {
    const notification = sessionRequest(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
    try { await charged(notification.body, notification.exchange); }
    catch (error) {
      const pending = { state, reply, requestBytes };
      if (isUnauthorized(error)) throw new ExtensionUpstreamHandshakeUnauthorizedError(pending);
      // A stateless upstream (no session id) that mishandles the notification (a 400/405, an empty or non-JSON 200)
      // still serves calls, as it did before the gateway sent one: keep the stateless state.
      if (!state.id) return pending;
      throw new ExtensionUpstreamHandshakeIncompleteError(pending, `notifications/initialized: ${extensionRequestFailureReason(error)}`);
    }
    return { state, reply, requestBytes };
  };
  if (resume) return notify(resume.state, resume.reply);
  /**
   * Abandon an `initialize` exchange: a session the upstream assigned before its reply failed (malformed, oversized,
   * timed out) or was not a result is never kept, so end it with a best-effort `DELETE` through the same transport
   * (a gateway call meters its response), then close the exchange's connection.
   */
  const abandon = async (exchange: ExtensionMcpExchange) => {
    const id = exchange.assignedSessionId;
    try { if (id) await post(null, { method: 'DELETE', sessionId: id, protocolVersion: MCP_2025_REVISIONS[0], ...(exchange.connection ? { connection: exchange.connection } : {}) }); }
    catch { /* best effort: the upstream expires it */ }
    finally { exchange.connection?.agent.destroy(); }
  };
  const initialize = { jsonrpc: '2.0', id: initializeId, method: 'initialize', params: { protocolVersion: MCP_2025_REVISIONS[0], capabilities: {}, clientInfo: { name: 'propr-extension-gateway', version: '1' } } };
  const opening: ExtensionMcpExchange = { protocolVersion: MCP_2025_REVISIONS[0], pin: true };
  let reply: unknown;
  try { reply = await send(initialize, opening); }
  catch (error) { await abandon(opening); throw error; }
  const initialized = resultOf(reply);
  // A revision the gateway does not speak is as unsupported as a refused `initialize`; a reply naming none is taken
  // as the legacy 2025-03-26 revision.
  const offered = initialized?.protocolVersion ?? '2025-03-26';
  const protocolVersion = MCP_2025_REVISIONS.find(version => version === offered);
  if (initialized && protocolVersion) {
    const id = opening.assignedSessionId;
    const connection = id ? opening.connection : pooled(opening.connection);
    const state: UpstreamSessionState = { mode: id ? 'stateful' : 'stateless', era: '2025', protocolVersion, ...(id ? { id } : {}), ...(connection ? { connection } : {}) };
    return notify(state, reply);
  }
  refused('initialize', reply, Boolean(initialized));
  await abandon(opening);
  const discovering: ExtensionMcpExchange = { protocolVersion: MCP_2026_REVISION, headers: { 'Mcp-Method': 'server/discover' }, pin: true };
  let discovered: Record<string, unknown> | undefined; let answer: unknown;
  try { discovered = resultOf(answer = await send({ jsonrpc: '2.0', id: 'propr-gateway-discover', method: 'server/discover', params: { _meta: MCP_2026_META } }, discovering)); }
  catch (error) { discovering.connection?.agent.destroy(); throw error; }
  if (discovered && Array.isArray(discovered.supportedVersions) && discovered.supportedVersions.includes(MCP_2026_REVISION)) {
    const connection = pooled(discovering.connection);
    return { state: { mode: 'stateless', era: '2026', protocolVersion: MCP_2026_REVISION, ...(connection ? { connection } : {}) }, reply, requestBytes };
  }
  refused('server/discover', answer, Boolean(discovered));
  discovering.connection?.agent.destroy();
  return { reply, requestBytes, ...(failures.length ? { failure: failures.join('; ') } : {}) };
}

/** Every session slot is held by a call in flight: a new session is refused rather than closing one of them. */
export class ExtensionUpstreamSessionCapacityError extends Error { constructor() { super('MCP session capacity reached'); } }
/** The entry was dropped (its grant ended, or shutdown): it never opens an upstream session again. */
export class ExtensionUpstreamSessionEndedError extends Error { constructor(readonly reason: string) { super('MCP session ended with the run grant'); } }

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
  /** Gateway calls using this entry now (from `entry()` to `release()`); an entry with any is never evicted for capacity or idleness. */
  active: number;
  /** Gateway calls, successful upstream tool calls, OAuth credential changes and re-initializations after a lost session. */
  calls: number; toolCalls: number; refreshes: number; reinitialized: number;
  /** Digest of the last credential used, to count OAuth refreshes without keeping the token. */
  credential?: string;
  /**
   * The session's `DELETE`, with the last credential a call resolved on this entry. Set when the entry is created and
   * replaced by `credentialUsed` only once a call has resolved its credential, so a grant-end `DELETE` that races a
   * call still waiting on its credential carries the previous token, never none.
   */
  remove: (exchange: ExtensionMcpExchange) => Promise<unknown>;
  /** Whether the run grant is still active and unexpired. */
  alive: () => Promise<boolean>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

export class ExtensionUpstreamSessions {
  private readonly entries = new Map<string, UpstreamSessionEntry>();
  /** Why each dropped entry was dropped. A call still holding one is refused, never given a new upstream session. */
  private readonly dropped = new WeakMap<UpstreamSessionEntry, string>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly limits = UPSTREAM_SESSION_LIMITS, private readonly now: () => number = Date.now) {}

  /**
   * Begin a call: the entry for (grant, server), created on first use, counted as in use until `release()`. Over a
   * cap, the least recently used idle session is closed; a session with a call in flight never is (its socket would
   * be destroyed mid-request, after a write may already have happened), so when every candidate is busy the new
   * session is refused instead.
   */
  entry(init: Pick<UpstreamSessionEntry, 'grant' | 'server' | 'taskId' | 'authentication' | 'remove' | 'alive'>): UpstreamSessionEntry {
    const key = `${init.grant}\0${init.server}`;
    let entry = this.entries.get(key);
    if (!entry) {
      // Pick every eviction before closing any, so a refused session closes nothing.
      const evicted: UpstreamSessionEntry[] = [];
      const evict = (candidates: UpstreamSessionEntry[]) => {
        const idle = this.leastRecent(candidates.filter(e => !evicted.includes(e)));
        if (!idle) throw new ExtensionUpstreamSessionCapacityError();
        evicted.push(idle);
      };
      const all = [...this.entries.values()];
      if (all.filter(e => e.grant === init.grant).length >= this.limits.perGrant) evict(all.filter(e => e.grant === init.grant));
      if (all.length - evicted.length >= this.limits.total) evict(all);
      for (const e of evicted) void this.drop(e, 'capacity');
      entry = { ...init, lastUsed: this.now(), active: 0, calls: 0, toolCalls: 0, refreshes: 0, reinitialized: 0 };
      this.entries.set(key, entry);
      this.schedule();
    }
    // `remove` is not replaced here: this call's credential is not resolved yet (see `credentialUsed`).
    entry.alive = init.alive; entry.lastUsed = this.now(); entry.active++;
    return entry;
  }

  /** End a call begun with `entry()`. */
  release(entry: UpstreamSessionEntry): void {
    entry.active = Math.max(0, entry.active - 1);
    entry.lastUsed = this.now();
  }

  /**
   * The open session, or a new one. Concurrent callers share one handshake; a
   * failed handshake is not kept, except a session the upstream assigned before
   * refusing the credential: the entry keeps it and the next handshake resumes it.
   * A session whose initialized notification failed otherwise is closed. A dropped entry (grant end, capacity,
   * shutdown) is refused, also when it is dropped during the handshake: the new session is closed and the call fails.
   */
  async open(entry: UpstreamSessionEntry, handshake: (resume?: HandshakeOutcome & { state: UpstreamSessionState }) => Promise<HandshakeOutcome>): Promise<HandshakeOutcome & { own: boolean }> {
    this.fence(entry);
    if (entry.state) return { state: entry.state, requestBytes: 0, own: false };
    if (entry.opening) { const shared = await entry.opening; this.fence(entry); return { state: shared.state, requestBytes: 0, own: false }; }
    const resume = entry.pending; entry.pending = undefined;
    const opening = handshake(resume);
    entry.opening = opening;
    const current = () => !this.dropped.has(entry);
    try {
      const outcome = await opening;
      if (!current()) {
        if (outcome.state) await closeUpstreamSession(outcome.state, entry.remove);
        this.fence(entry);
      }
      if (outcome.state) {
        entry.state = outcome.state;
        logger.info({ taskId: entry.taskId, server: entry.server, sessionMode: outcome.state.mode, protocolVersion: outcome.state.protocolVersion, authentication: entry.authentication, reinitialized: entry.reinitialized }, 'Opened extension URL MCP upstream session');
      }
      return { ...outcome, own: true };
    } catch (error) {
      if (error instanceof ExtensionUpstreamSessionEndedError || error instanceof ExtensionUpstreamSessionCapacityError) throw error;
      if (error instanceof ExtensionUpstreamHandshakeUnauthorizedError) {
        if (current()) entry.pending = error.pending;
        else await closeUpstreamSession(error.pending.state, entry.remove);
      } else if (error instanceof ExtensionUpstreamHandshakeIncompleteError) await closeUpstreamSession(error.pending.state, entry.remove);
      else if (resume) await closeUpstreamSession(resume.state, entry.remove);
      throw error;
    } finally { entry.opening = undefined; }
  }

  /** The upstream lost the session: forget it without a DELETE. */
  forget(entry: UpstreamSessionEntry, state: UpstreamSessionState): void {
    if (entry.state !== state) return;
    entry.state = undefined; state.connection?.agent.destroy();
  }

  /**
   * A call resolved its credential: the entry's `DELETE` now uses it (with that call's transport), and a change (an
   * OAuth refresh) is counted for this session's telemetry.
   */
  credentialUsed(entry: UpstreamSessionEntry, credential: string | undefined, remove: UpstreamSessionEntry['remove']): void {
    entry.remove = remove;
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
      for (const entry of entries) if (!alive || (!entry.active && now - entry.lastUsed > this.limits.idleMs)) await this.drop(entry, alive ? 'idle' : 'grant_ended');
    }
  }

  size(): number { return this.entries.size; }
  /** Test and shutdown support: close everything. */
  async closeAll(reason = 'shutdown'): Promise<void> { await Promise.all([...this.entries.values()].map(e => this.drop(e, reason))); }
  peek(grant: string, server: string): UpstreamSessionEntry | undefined { return this.entries.get(`${grant}\0${server}`); }

  private async drop(entry: UpstreamSessionEntry, reason: string): Promise<void> {
    const key = `${entry.grant}\0${entry.server}`;
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key); this.dropped.set(entry, reason);
    const state = entry.state ?? entry.pending?.state; entry.state = undefined; entry.pending = undefined;
    const deleted = state ? await closeUpstreamSession(state, entry.remove) : false;
    logger.info({ taskId: entry.taskId, server: entry.server, sessionMode: state?.mode ?? null, authentication: entry.authentication, reason, calls: entry.calls, toolCalls: entry.toolCalls, refreshes: entry.refreshes, reinitialized: entry.reinitialized, deleted }, 'Closed extension URL MCP upstream session');
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Refuse a dropped entry with the error of its drop. */
  private fence(entry: UpstreamSessionEntry): void {
    const reason = this.dropped.get(entry);
    if (reason === undefined) return;
    throw reason === 'capacity' ? new ExtensionUpstreamSessionCapacityError() : new ExtensionUpstreamSessionEndedError(reason);
  }

  /** The least recently used entry without a call in flight. */
  private leastRecent(entries: UpstreamSessionEntry[]): UpstreamSessionEntry | undefined {
    return entries.filter(e => !e.active).reduce<UpstreamSessionEntry | undefined>((oldest, e) => (!oldest || e.lastUsed < oldest.lastUsed ? e : oldest), undefined);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, this.limits.sweepMs);
    this.timer.unref();
  }
}

/**
 * This process's upstream sessions: one registry per process, even when this module is loaded twice (the API loads
 * the gateway from Core's sources, while run launch and shutdown may load Core's build), so a grant's end and the
 * API's shutdown reach the sessions the gateway opened.
 */
const REGISTRY = Symbol.for('propr.extensionUpstreamSessions');
export const extensionUpstreamSessions: ExtensionUpstreamSessions = (globalThis as Record<symbol, ExtensionUpstreamSessions | undefined>)[REGISTRY] ??= new ExtensionUpstreamSessions();

/** Close every session within `timeoutMs` (graceful shutdown); a DELETE still in flight then is abandoned. */
export async function closeExtensionUpstreamSessions(reason = 'shutdown', timeoutMs = 5_000, sessions = extensionUpstreamSessions): Promise<void> {
  await bounded(sessions.closeAll(reason), timeoutMs);
}

/** End a run grant's sessions within `timeoutMs`, ahead of the sweep (which stays the fallback). */
export async function closeExtensionGrantSessions(grant: string, reason = 'grant_ended', timeoutMs = 5_000, sessions = extensionUpstreamSessions): Promise<void> {
  await bounded(sessions.closeGrant(grant, reason), timeoutMs);
}

async function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref(); })]);
  } finally { clearTimeout(timer); }
}

export interface ExtensionMcpProbe {
  /** The upstream completed a handshake (or answered `initialize`). */
  reachable: boolean;
  /** `stateful` when the upstream assigned a session; null when no handshake completed. */
  session: UpstreamSessionMode | null;
  protocolVersion: string | null;
  /** The `tools/list` reply, when asked for. */
  tools?: unknown;
  /** When not reachable: why, short and secret-free. */
  reason?: string;
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
    // No refresh here: end a session the upstream assigned before refusing the credential or the notification.
    if (error instanceof ExtensionUpstreamHandshakeUnauthorizedError || error instanceof ExtensionUpstreamHandshakeIncompleteError) await closeUpstreamSession(error.pending.state, exchange => send(endpoint, null, credential, {}, exchange));
    throw error;
  }
  const { state } = outcome;
  try {
    let tools: unknown;
    if (options.listTools) {
      const request = sessionRequest(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      tools = await post(request.body, request.exchange);
    }
    const reachable = Boolean(state) || Boolean(resultOf(outcome.reply));
    return { reachable, session: state?.mode ?? null, protocolVersion: state?.protocolVersion ?? null, ...(options.listTools ? { tools } : {}), ...(reachable ? {} : { reason: outcome.failure ?? 'no MCP handshake completed' }) };
  } finally {
    if (state) await closeUpstreamSession(state, exchange => send(endpoint, null, credential, {}, exchange));
  }
}
