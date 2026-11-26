import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sprite } from '@fly/sprites';
import ssh2, { type ClientChannel } from 'ssh2';
import logger from '../../../utils/logger.js';
import {
    SPRITES_MCP_FORWARD_HOST, SPRITES_MCP_FORWARD_PORT, SPRITES_MCP_FORWARD_SCRIPT, SPRITES_MCP_FORWARD_USER, SPRITES_MCP_SSHD_PORT,
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
    /** Reconnect attempts after a drop (default 5); the first connection gets as many. */
    retries?: number;
    /** Base reconnect backoff in ms (default 500, doubling, capped at 8s). */
    retryDelayMs?: number;
    /** Test seam: opens the worker-side proxy to the Sprite's sshd. */
    openProxy?: (sprite: ForwardSprite) => Promise<SpritesMcpProxy>;
    /** Test seam: the login user (an unprivileged test sshd can only admit its own user). */
    user?: string;
    /** Test seam: opens the worker-side connection to the target. */
    connectTarget?: (target: SpritesMcpForwardTarget) => net.Socket;
}

function connectTarget(target: SpritesMcpForwardTarget): net.Socket {
    if (target.protocol === 'https:') {
        return tls.connect({ host: target.host, port: target.port, ...(net.isIP(target.host) ? {} : { servername: target.host }) });
    }
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
    private readonly clientKey = ssh2.utils.generateKeyPairSync('ed25519');
    private readonly hostKey = ssh2.utils.generateKeyPairSync('ed25519');
    private readonly hostKeyBlob = publicKeyBlob(this.hostKey.public);
    private readonly channels = new Set<{ destroy(): unknown }>();
    private readonly closer = new AbortController();
    private readonly signal: AbortSignal;
    private client?: ssh2.Client;
    private proxy?: SpritesMcpProxy;
    private closing?: Promise<void>;
    private lost = false;
    private configured = false;
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

    /** Reconnect policy for runs that do not pass their own (tests shorten it). */
    static defaults = { retries: 5, retryDelayMs: 500 };
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
            client.connect({
                sock: await connectProxy(proxyPort(proxy)), username: this.options.user ?? SPRITES_MCP_FORWARD_USER,
                privateKey: this.clientKey.private, agent: undefined, tryKeyboard: false,
                hostVerifier: (key: Buffer) => key.length === this.hostKeyBlob.length && timingSafeEqual(key, this.hostKeyBlob),
                readyTimeout: 20_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
            });
            await established;
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
        for (let attempt = phase === 'connect' ? 0 : 1; attempt <= this.retries; attempt++) {
            if (attempt > 0) {
                const wait = Math.min(8000, (this.options.retryDelayMs ?? SpritesMcpForward.defaults.retryDelayMs) * 2 ** (attempt - 1));
                await delay(wait, undefined, { signal: this.signal });
                if (phase === 'reconnect') this.log('warn', { attempt, retries: this.retries }, 'Reconnecting the ProPR MCP SSH reverse forward');
            }
            try {
                await this.connectOnce();
                if (phase === 'reconnect') this.log('info', { attempt }, 'ProPR MCP SSH reverse forward reconnected');
                return;
            } catch (error) {
                this.signal.throwIfAborted();
                last = error;
            }
        }
        throw new SpritesMcpForwardError(`ProPR MCP transport lost: the SSH reverse forward to Sprite ${this.options.sprite.name} could not be ${phase === 'connect' ? 'established' : 're-established'} after ${this.retries} ${phase === 'connect' ? 'retries' : 'reconnect attempts'} (${message(last)})`, { cause: last });
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

    /** Relay one connection the agent opened to the loopback listener to the target, and nothing else. */
    private relay(accept: () => ClientChannel, reject: () => void) {
        if (this.signal.aborted) return reject();
        const upstream = (this.options.connectTarget ?? connectTarget)(this.options.target);
        const refuse = () => { upstream.destroy(); reject(); };
        upstream.once('error', refuse);
        upstream.once(this.options.target.protocol === 'https:' && !this.options.connectTarget ? 'secureConnect' : 'connect', () => {
            upstream.off('error', refuse);
            if (this.signal.aborted) return refuse();
            upstream.setNoDelay(true);
            const channel = accept();
            const entry = { destroy: () => { upstream.destroy(); channel.destroy(); } };
            this.channels.add(entry);
            const done = () => { this.channels.delete(entry); entry.destroy(); };
            upstream.on('error', done);
            channel.on('error', done);
            upstream.once('close', done);
            channel.once('close', done);
            // Streamed and SSE responses flow as they arrive: plain byte pipes, no buffering.
            channel.pipe(upstream);
            upstream.pipe(channel);
        });
    }

    /** Tear the forward down: the tunnel at once, then the run's sshd on the Sprite (best effort). */
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
            await this.options.sprite.execFile('sudo', ['-n', SPRITES_MCP_FORWARD_SCRIPT, 'stop'], { cwd: '/', timeout: 10_000 })
                .catch(error => this.log('warn', { error: message(error) }, 'Could not stop the ProPR MCP forward sshd; the Sprite reset stops it'));
        })();
    }
}
