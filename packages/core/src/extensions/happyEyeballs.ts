import net from 'node:net';
import type http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';

/** One address an endpoint resolved to, already vetted by the endpoint policy. */
export interface ExtensionDialAddress { address: string; family: number }
/** How long an attempt may go without connecting before the next address is tried alongside it (RFC 8305's Connection Attempt Delay). */
export const HAPPY_EYEBALLS_DELAY_MS = 250;
/** How long one address may take to accept a TCP connection. */
export const ADDRESS_CONNECT_TIMEOUT_MS = 3_000;

/**
 * No vetted address accepted a connection. `reason` names each attempt's family, address and outcome in the order
 * they were tried, e.g. `connect timeout (IPv6 2001:db8::1, then IPv4 192.0.2.1)`. It carries no host name, header
 * or credential: the addresses are the ones the endpoint policy vetted.
 */
export class ExtensionConnectError extends Error { constructor(readonly reason: string) { super('MCP connection failed'); } }

const familyName = (family: number) => family === 6 ? 'IPv6' : 'IPv4';
const errorCode = (error: NodeJS.ErrnoException) => typeof error.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : 'error';

/** RFC 8305 ordering: the resolver's order within each family, alternating families from the first answer's family. */
export function interleaveAddressFamilies(addresses: readonly ExtensionDialAddress[]): ExtensionDialAddress[] {
  if (!addresses.length) return [];
  const first = addresses[0].family;
  const primary = addresses.filter(a => a.family === first); const secondary = addresses.filter(a => a.family !== first);
  const ordered: ExtensionDialAddress[] = [];
  for (let i = 0; i < Math.max(primary.length, secondary.length); i++) {
    if (i < primary.length) ordered.push(primary[i]);
    if (i < secondary.length) ordered.push(secondary[i]);
  }
  return ordered;
}

export interface HappyEyeballsOptions {
  port?: number;
  /** The whole connect phase's budget: attempts still running when it ends fail as timed out. */
  budgetMs: number;
  delayMs?: number;
  attemptTimeoutMs?: number;
}
type Connected = (error: ExtensionConnectError | null, socket?: net.Socket, address?: ExtensionDialAddress) => void;

/**
 * Connect to the first of `addresses` that accepts a TCP connection, Happy Eyeballs style: attempts start in
 * {@link interleaveAddressFamilies} order, the next one {@link HAPPY_EYEBALLS_DELAY_MS} after the previous started
 * (or at once when it fails), each with its own connect timeout. The first connected socket wins and every other
 * attempt is closed. Only the given addresses are dialled: they are IP literals, so no name is resolved here.
 */
export function connectHappyEyeballs(addresses: readonly ExtensionDialAddress[], options: HappyEyeballsOptions, callback: Connected): void {
  const order = interleaveAddressFamilies(addresses);
  const { port = 443, budgetMs, delayMs = HAPPY_EYEBALLS_DELAY_MS, attemptTimeoutMs = ADDRESS_CONNECT_TIMEOUT_MS } = options;
  const outcomes: Array<string | undefined> = order.map(() => undefined);
  const live = new Map<number, { socket: net.Socket; timer: NodeJS.Timeout }>();
  let next = 0; let done = false; let stagger: NodeJS.Timeout | undefined;
  const finish = () => { done = true; clearTimeout(stagger); clearTimeout(overall); for (const { socket, timer } of live.values()) { clearTimeout(timer); socket.destroy(); } live.clear(); };
  const failure = () => {
    const tried = order.map((target, index) => ({ target, outcome: outcomes[index] })).filter(entry => entry.outcome !== undefined);
    const timedOut = tried.length > 0 && tried.every(entry => entry.outcome === 'timed out');
    const attempts = tried.map(({ target, outcome }) => `${familyName(target.family)} ${target.address}${timedOut ? '' : ` ${outcome}`}`).join(', then ');
    const untried = order.length - tried.length;
    return new ExtensionConnectError(`${timedOut ? 'connect timeout' : 'connect failed'} (${attempts || 'no address'}${untried ? `; ${untried} more not tried` : ''})`);
  };
  const exhausted = () => { if (!done && next >= order.length && live.size === 0) { finish(); callback(failure()); } };
  const start = () => {
    clearTimeout(stagger);
    if (done || next >= order.length) return;
    const index = next++; const target = order[index];
    const socket = net.connect({ host: target.address, port, family: target.family });
    const settle = (outcome: string) => {
      if (done || outcomes[index] !== undefined) return;
      outcomes[index] = outcome; clearTimeout(timer); live.delete(index); socket.destroy();
      start(); exhausted();
    };
    const timer = setTimeout(() => settle('timed out'), attemptTimeoutMs);
    live.set(index, { socket, timer });
    const onError = (error: NodeJS.ErrnoException) => settle(errorCode(error));
    socket.once('error', onError);
    socket.once('connect', () => {
      if (done) { socket.destroy(); return; }
      socket.off('error', onError); clearTimeout(timer); live.delete(index);
      finish();
      callback(null, socket, target);
    });
    if (next < order.length) { stagger = setTimeout(start, delayMs); }
  };
  const overall = setTimeout(() => {
    if (done) return;
    for (const index of live.keys()) outcomes[index] = 'timed out';
    finish(); callback(failure());
  }, Math.max(budgetMs, 0));
  if (!order.length) { finish(); callback(failure()); return; }
  start();
}

/** When each connection's connect phase began, so a request can charge it against its own budget. */
const connectStarts = new WeakMap<net.Socket, number>();
/** When the connect phase of `socket` began, if this socket was opened for the request it was just assigned to. Read once. */
export function takeConnectStart(socket: net.Socket): number | undefined {
  const started = connectStarts.get(socket); connectStarts.delete(socket); return started;
}

/** Which address a connection dialled and whether its TLS handshake finished, for timeout reasons. Kept for the socket's life. */
const connectionTraces = new WeakMap<net.Socket, { address: ExtensionDialAddress; tlsDone: boolean }>();

/**
 * Where a timed-out request stopped, e.g. `connected over IPv6 2001:db8::1, TLS done, no response`. Secret-free: the
 * address is one the endpoint policy vetted, and nothing of the request or response is included. `socket` is the one
 * the request was assigned (undefined: it never got one); `response` says whether response headers arrived.
 */
export function requestStageDetail(socket: net.Socket | undefined, response: boolean): string {
  const trace = socket ? connectionTraces.get(socket) : undefined;
  if (!trace) return socket ? 'connecting' : 'not connected';
  return `connected over ${familyName(trace.address.family)} ${trace.address.address}, ${trace.tlsDone ? 'TLS done' : 'TLS not done'}, ${response ? 'response headers received, body incomplete' : 'no response'}`;
}

/**
 * An HTTPS agent that dials only vetted addresses, Happy Eyeballs style, then runs TLS over the connected socket with
 * the request's TLS identity (`servername`). `targets` is read for every new connection: a session's agent narrows it
 * to the address that connected first, so the session keeps using that address.
 */
export class ExtensionDialAgent extends https.Agent {
  constructor(private readonly targets: () => readonly ExtensionDialAddress[], private readonly budgetMs: number, private readonly onConnected: (address: ExtensionDialAddress) => void = () => {}, options: https.AgentOptions = {}) {
    super(options);
  }

  override createConnection(options: http.ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void): undefined {
    const started = Date.now();
    connectHappyEyeballs(this.targets(), { port: Number(options.port) || 443, budgetMs: this.budgetMs }, (error, socket, address) => {
      if (error || !socket || !address) { callback?.(error ?? new ExtensionConnectError('connect failed'), undefined as unknown as Duplex); return; }
      this.onConnected(address);
      // With `socket` given, TLS runs over the connected socket; `host` stays only for certificate checks of IP endpoints.
      const secure = tls.connect({ ...(options as tls.ConnectionOptions), port: undefined, socket });
      connectStarts.set(secure, started);
      const trace = { address, tlsDone: false };
      connectionTraces.set(secure, trace);
      secure.once('secureConnect', () => { trace.tlsDone = true; });
      callback?.(null, secure);
    });
    return undefined;
  }
}
