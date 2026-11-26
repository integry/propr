import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sprite } from '@fly/sprites';
import ssh2, { type ClientChannel } from 'ssh2';
import logger from '../../../utils/logger.js';
import {
    SPRITES_MCP_FORWARD_HOST, SPRITES_MCP_FORWARD_PORT, SPRITES_MCP_FORWARD_SCRIPT, SPRITES_MCP_FORWARD_USER, SPRITES_MCP_SSHD_DEAD_PEER_MS, SPRITES_MCP_SSHD_PORT,
    spritesMcpAuthorizedKey, spritesMcpSshdConfig, type SpritesMcpForwardTarget,
} from './spritesMcpForwardConfig.js';

/** Where the forward helper installs the run's sshd files on the Sprite (root-owned). */
export const SPRITES_MCP_FORWARD_RUN_DIR = '/run/propr-mcp-forward';

/** The run lost its ProPR MCP transport: tool calls would hang, so the run fails. */
export class SpritesMcpForwardError extends Error {
    readonly code = 'MCP_TRANSPORT_LOST';
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'SpritesMcpForwardError';
    }
}

type ForwardSprite = Pick<Sprite, 'name' | 'execFile' | 'filesystem' | 'proxyPort'>;
/** The part of a Sprites `ProxySession` the forward uses. */
export interface SpritesMcpProxy { localAddr(): string | null; close(): void; on(event: 'error', listener: (error: unknown) => void): unknown }

export interface SpritesMcpForwardOptions {
    sprite: ForwardSprite;
    target: SpritesMcpForwardTarget;
    signal: AbortSignal;
    /** Called once when the forward is gone for good (reconnects exhausted). */
    onLost: (error: SpritesMcpForwardError) => void;
    run?: string;
    /** Reconnect attempts after a drop (default 5, at least); the first connection gets as many. */
    retries?: number;
    /** Base reconnect backoff in ms (default 500, doubling, capped at 8s). */
    retryDelayMs?: number;
    /**
     * A reconnect keeps trying (past `retries`) until this much time has passed
     * since the drop. The default is three times sshd's dead-peer timeout, so a
     * stale session that the reset could not clear is gone before we give up.
     */
    reconnectWindowMs?: number;
    /** Test seam: opens the worker-side proxy to the Sprite's sshd. */
    openProxy?: (sprite: ForwardSprite) => Promise<SpritesMcpProxy>;
    /** Test seam: the login user (an unprivileged test sshd can only admit its own user). */
    user?: string;
    /** Test seam: opens the worker's TCP connection to the local end of the proxy. */
    connectProxy?: (port: number) => Promise<net.Socket>;
    /** Test seam: opens the worker-side connection to the target. */
    connectTarget?: (target: SpritesMcpForwardTarget) => net.Socket;
    /** Deadline for one upstream connection to the target, in ms (default 10s); a slower one is refused. */
    connectTimeoutMs?: number;
}

/** Plain TCP to the internal API: the target is http:// on an internal address (see spritesMcpForwardTarget). */
function connectTarget(target: SpritesMcpForwardTarget): net.Socket {
    return net.connect({ host: target.host, port: target.port });
}

function proxyPort(proxy: SpritesMcpProxy): number {
    const address = proxy.localAddr();
    const port = Number(address?.slice(address.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port <= 0) throw new Error('Sprites proxy did not report a local port');
    return port;
}

/** The Sprites proxy listens on "localhost", which may be ::1 or 127.0.0.1: try each address in turn. */
async function connectProxy(port: number): Promise<net.Socket> {
    const addresses = await lookup('localhost', { all: true });
    let last: unknown = new Error('localhost does not resolve');
    for (const { address } of addresses) {
        try {
            return await new Promise<net.Socket>((resolve, reject) => {
                const socket = net.connect({ host: address, port });
                socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
                socket.once('error', reject);
            });
        } catch (error) { last = error; }
    }
    throw last;
}

function publicKeyBlob(publicKey: string): Buffer {
    return Buffer.from(publicKey.trim().split(/\s+/)[1] ?? '', 'base64');
}

/**
 * An ed25519 key pair ssh2 can parse back. ssh2's generator occasionally (about
 * 1 in 250) emits a private key its own parser rejects as malformed, which
 * would fail every connection attempt of the run; draw again in that case.
 */
function generateKeyPair(): { private: string; public: string } {
    for (let attempt = 0; ; attempt++) {
        const pair = ssh2.utils.generateKeyPairSync('ed25519');
        if (!(ssh2.utils.parseKey(pair.private) instanceof Error) || attempt >= 20) return pair;
    }
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One run's SSH reverse forward. The keys exist only in this object: the
 * client key authenticates the worker to the run's sshd, and the host key
 * (generated here too) lets the worker verify it reached that sshd and not
 * anything else listening behind the proxy. Neither is logged or persisted on
 * the worker; the Sprite keeps the host key and public client key only until
 * the run ends and the Sprite is reset to its clean checkpoint.
 */
export class SpritesMcpForward {
    private readonly clientKey = generateKeyPair();
    private readonly hostKey = generateKeyPair();
    private readonly hostKeyBlob = publicKeyBlob(this.hostKey.public);
    private readonly channels = new Set<{ destroy(): unknown }>();
    private readonly closer = new AbortController();
    private readonly signal: AbortSignal;
    private client?: ssh2.Client;
    private proxy?: SpritesMcpProxy;
    private closing?: Promise<void>;
    private lost = false;
    private configured = false;
    /** The background `mcp-forward.sh stop` close() started; observable for tests. */
    remoteStop?: Promise<void>;
    /** Connections established, including the first; observable for diagnostics and tests. */
    connections = 0;

    private constructor(private readonly options: SpritesMcpForwardOptions) {
        this.signal = AbortSignal.any([options.signal, this.closer.signal]);
    }

    /** Configure the run's sshd and establish the forward; resolves once the remote listener is bound. */
    static async start(options: SpritesMcpForwardOptions): Promise<SpritesMcpForward> {
        const forward = new SpritesMcpForward(options);
        try {
            await forward.configure();
            await forward.connectWithRetries('connect');
            return forward;
        } catch (error) {
            await forward.close();
            throw error instanceof SpritesMcpForwardError ? error
                : new SpritesMcpForwardError(`Could not start the ProPR MCP SSH reverse forward to Sprite ${options.sprite.name}: ${message(error)}`, { cause: error });
        }
    }

    /** Reconnect and upstream-connect policy for runs that do not pass their own (tests shorten it). */
    static defaults = { retries: 5, retryDelayMs: 500, connectTimeoutMs: 10_000, reconnectWindowMs: 3 * SPRITES_MCP_SSHD_DEAD_PEER_MS };
    private get retries() { return this.options.retries ?? SpritesMcpForward.defaults.retries; }

    private log(level: 'info' | 'warn', details: Record<string, unknown>, text: string) {
        logger[level]({ sprite: this.options.sprite.name, run: this.options.run, mcpTransport: 'ssh-reverse-forward', ...details }, text);
    }

    private async configure() {
        const { sprite } = this.options;
        const fs = sprite.filesystem();
        // The inbox is private to the Sprite's filesystem user; the root helper moves the files out of it.
        const dir = `/opt/propr/inbox/mcp-forward-${randomUUID()}`;
        await fs.mkdir(dir, { mode: 0o700 });
        await fs.writeFile(`${dir}/host_key`, this.hostKey.private, { mode: 0o600 });
        await fs.writeFile(`${dir}/authorized_keys`, spritesMcpAuthorizedKey(this.clientKey.public), { mode: 0o600 });
        await fs.writeFile(`${dir}/sshd_config`, spritesMcpSshdConfig(SPRITES_MCP_FORWARD_RUN_DIR), { mode: 0o600 });
        this.signal.throwIfAborted();
        this.configured = true;
        await sprite.execFile('sudo', ['-n', SPRITES_MCP_FORWARD_SCRIPT, 'start', dir], { cwd: '/', signal: this.signal, timeout: 30_000 });
    }

    private async openProxy() {
        this.proxy?.close();
        this.proxy = undefined;
        const proxy = await (this.options.openProxy?.(this.options.sprite)
            ?? this.options.sprite.proxyPort(0, SPRITES_MCP_SSHD_PORT, SPRITES_MCP_FORWARD_HOST));
        // A failed proxied connection is an 'error' event; an unhandled one would crash the worker.
        proxy.on('error', () => {});
        if (this.signal.aborted) {
            proxy.close();
            this.signal.throwIfAborted();
        }
        this.proxy = proxy;
        return proxy;
    }

    private async connectOnce() {
        const proxy = await this.openProxy();
        const client = new ssh2.Client();
        const abort = () => client.end();
        let fail!: (error: unknown) => void;
        const established = new Promise<void>((resolve, reject) => {
            fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
            client.once('ready', () => {
                client.forwardIn(SPRITES_MCP_FORWARD_HOST, SPRITES_MCP_FORWARD_PORT, error => error ? fail(error) : resolve());
            });
        });
        const closedEarly = () => fail(new Error('SSH connection closed before the forward was established'));
        client.on('error', fail);
        client.once('close', closedEarly);
        client.on('tcp connection', (_info, accept, reject) => this.relay(accept, reject));
        this.signal.addEventListener('abort', abort, { once: true });
        try {
            const sock = await (this.options.connectProxy ?? connectProxy)(proxyPort(proxy));
            // close() may have run while the socket was opening: its abort found no connection to end.
            if (this.signal.aborted) {
                sock.destroy();
                this.signal.throwIfAborted();
            }
            client.connect({
                sock, username: this.options.user ?? SPRITES_MCP_FORWARD_USER,
                privateKey: this.clientKey.private, agent: undefined, tryKeyboard: false,
                hostVerifier: (key: Buffer) => key.length === this.hostKeyBlob.length && timingSafeEqual(key, this.hostKeyBlob),
                readyTimeout: 20_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
            });
            await established;
            // Closed during the handshake after the listener was granted: never adopt the connection.
            this.signal.throwIfAborted();
        } catch (error) {
            this.signal.removeEventListener('abort', abort);
            client.off('close', closedEarly);
            client.on('error', () => {});
            client.end();
            throw error;
        } finally {
            client.off('error', fail);
        }
        // Keepalive failures and socket errors end in 'close'; reconnect from there.
        client.on('error', () => {});
        client.off('close', closedEarly);
        client.once('close', () => {
            this.signal.removeEventListener('abort', abort);
            this.dropped(client);
        });
        this.client = client;
        this.connections++;
    }

    private async connectWithRetries(phase: 'connect' | 'reconnect') {
        let last: unknown;
        const startedAt = Date.now();
        const window = phase === 'reconnect' ? this.options.reconnectWindowMs ?? SpritesMcpForward.defaults.reconnectWindowMs : 0;
        let attempt = phase === 'connect' ? 0 : 1;
        for (; attempt <= this.retries || Date.now() - startedAt < window; attempt++) {
            if (attempt > 0) {
                const wait = Math.min(8000, (this.options.retryDelayMs ?? SpritesMcpForward.defaults.retryDelayMs) * 2 ** (attempt - 1));
                await delay(wait, undefined, { signal: this.signal });
                if (phase === 'reconnect') this.log('warn', { attempt, retries: this.retries }, 'Reconnecting the ProPR MCP SSH reverse forward');
            }
            try {
                if (phase === 'reconnect') await this.resetSessions();
                await this.connectOnce();
                if (phase === 'reconnect') this.log('info', { attempt }, 'ProPR MCP SSH reverse forward reconnected');
                return;
            } catch (error) {
                this.signal.throwIfAborted();
                last = error;
            }
        }
        const attempts = phase === 'connect' ? this.retries : attempt - 1;
        throw new SpritesMcpForwardError(`ProPR MCP transport lost: the SSH reverse forward to Sprite ${this.options.sprite.name} could not be ${phase === 'connect' ? 'established' : 're-established'} after ${attempts} ${phase === 'connect' ? 'retries' : 'reconnect attempts'} (${message(last)})`, { cause: last });
    }

    /**
     * Before re-forwarding, end the forward user's stale sessions on the Sprite.
     * After a half-open proxy path, sshd still holds 127.0.0.1:39080 for the old
     * connection until its dead-peer timeout, and every new `forwardIn` fails
     * with "address in use". The helper kills those sessions over the Sprites
     * exec API (not the proxy) and waits until the port is free. A failure is
     * only logged: sshd's own dead-peer timeout frees the port as well.
     */
    private async resetSessions() {
        try {
            await this.options.sprite.execFile('sudo', ['-n', SPRITES_MCP_FORWARD_SCRIPT, 'reset-sessions'], { cwd: '/', signal: this.signal, timeout: 15_000 });
        } catch (error) {
            this.signal.throwIfAborted();
            this.log('warn', { error: message(error) }, 'Could not reset stale ProPR MCP forward sessions; waiting for sshd to drop them');
        }
    }

    private dropped(client: ssh2.Client) {
        if (this.client !== client) return;
        this.client = undefined;
        if (this.signal.aborted) return;
        this.log('warn', {}, 'ProPR MCP SSH reverse forward dropped');
        void this.connectWithRetries('reconnect').catch(error => {
            if (this.signal.aborted || this.lost) return;
            this.lost = true;
            const lost = error instanceof SpritesMcpForwardError ? error : new SpritesMcpForwardError(`ProPR MCP transport lost: ${message(error)}`, { cause: error });
            this.log('warn', { error: lost.message }, 'ProPR MCP SSH reverse forward lost');
            this.options.onLost(lost);
        });
    }

    /**
     * Relay one connection the agent opened to the loopback listener to the
     * target, and nothing else. The upstream socket is tracked from the moment
     * it is created, so closing the forward while it is still connecting
     * destroys it, and a connection that does not complete within the deadline
     * is refused instead of waiting on an unreachable target.
     */
    private relay(accept: () => ClientChannel, reject: () => void) {
        if (this.signal.aborted) return reject();
        const upstream = (this.options.connectTarget ?? connectTarget)(this.options.target);
        let channel: ClientChannel | undefined;
        const entry = { destroy: () => { upstream.destroy(); channel?.destroy(); } };
        this.channels.add(entry);
        let pending = true;
        const refuse = () => {
            if (!pending) return;
            pending = false;
            clearTimeout(deadline);
            this.channels.delete(entry);
            // A late error on the abandoned socket must not go unhandled.
            upstream.on('error', () => {});
            upstream.destroy();
            // The SSH connection may already be gone (forward closing); nothing is left to refuse then.
            try { reject(); } catch { /* connection closed */ }
        };
        const deadline = setTimeout(refuse, this.options.connectTimeoutMs ?? SpritesMcpForward.defaults.connectTimeoutMs);
        deadline.unref();
        upstream.once('error', refuse);
        upstream.once('close', refuse);
        upstream.once('connect', () => {
            if (!pending) return;
            if (this.signal.aborted) return refuse();
            pending = false;
            clearTimeout(deadline);
            upstream.off('error', refuse);
            upstream.off('close', refuse);
            upstream.setNoDelay(true);
            const opened = channel = accept();
            const done = () => { this.channels.delete(entry); entry.destroy(); };
            upstream.on('error', done);
            opened.on('error', done);
            upstream.once('close', done);
            opened.once('close', done);
            // Streamed and SSE responses flow as they arrive: plain byte pipes, no buffering.
            opened.pipe(upstream);
            upstream.pipe(opened);
        });
    }

    /**
     * Tear the forward down: the tunnel at once, then the run's sshd on the
     * Sprite, best effort and in the background: the run's slot is released
     * without waiting for it, and the Sprite reset stops sshd anyway.
     */
    close(): Promise<void> {
        return this.closing ??= (async () => {
            this.closer.abort();
            const client = this.client;
            this.client = undefined;
            client?.end();
            for (const channel of [...this.channels]) channel.destroy();
            this.channels.clear();
            this.proxy?.close();
            this.proxy = undefined;
            if (!this.configured) return;
            this.remoteStop = this.options.sprite.execFile('sudo', ['-n', SPRITES_MCP_FORWARD_SCRIPT, 'stop'], { cwd: '/', timeout: 10_000 })
                .then(() => {}, error => this.log('warn', { error: message(error) }, 'Could not stop the ProPR MCP forward sshd; the Sprite reset stops it'));
        })();
    }
}
