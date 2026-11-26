import { EventEmitter } from 'node:events';
import net from 'node:net';
import ssh2, { type Connection, type ParsedKey } from 'ssh2';
import { SPRITES_MCP_FORWARD_HOST, SPRITES_MCP_FORWARD_PORT, SPRITES_MCP_FORWARD_SCRIPT, SPRITES_MCP_FORWARD_USER, SPRITES_MCP_SSHD_PORT }
    from '../../packages/core/src/agents/runtime/sprites/spritesMcpForwardConfig.ts';
import type { FakeSprite } from './fakeSprites.ts';

/**
 * Stands in for the run's sshd inside a fake Sprite: `mcp-forward.sh start`
 * starts an ssh2 server from the uploaded host key and authorized key, and
 * `proxyPort` opens a local listener to it like the Sprites API proxy. A
 * granted `tcpip-forward` gets an ephemeral loopback listener (`listenPort`)
 * standing for 127.0.0.1:39080 inside the Sprite.
 */
export class FakeSpriteSshd {
    server?: ssh2.Server;
    sshdPort = 0;
    listenPort?: Promise<number>;
    private resolveListen?: (port: number) => void;
    readonly connections = new Set<Connection>();
    private readonly listeners = new Set<net.Server>();
    readonly started: Array<{ config: string; authorizedKeys: string }> = [];
    stops = 0;
    authAttempts = 0;
    forwardRequests: Array<{ bindAddr: string; bindPort: number }> = [];
    refuseProxy = false;
    proxies = 0;
    failStart = false;
    /** Serve this host key instead of the uploaded one (an impostor behind the proxy). */
    hostKeyOverride?: string;
    /**
     * Set by {@link dropHalfOpen}: the stale session still holds 127.0.0.1:39080
     * (as sshd does until its dead-peer timeout), so `tcpip-forward` fails with
     * "address in use" until `mcp-forward.sh reset-sessions` ends it.
     */
    portHeld = false;
    resets = 0;
    /** Called when a client starts authenticating (the handshake is under way). */
    onAuthentication?: () => void;
    /** Called when the listener is requested, before it is granted. */
    onForwardRequest?: () => void;

    constructor(readonly sprite: FakeSprite) {
        this.resetListen();
        const execFile = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd: string, args: string[], options?: { signal?: AbortSignal }) => {
            if (cmd === 'sudo' && args[1] === SPRITES_MCP_FORWARD_SCRIPT) {
                if (args[2] === 'start') return this.start(args[3]);
                if (args[2] === 'stop') { this.stop(); sprite.events.push('forward-stop'); return { exitCode: 0, stdout: '', stderr: '' }; }
                if (args[2] === 'reset-sessions') { this.resets++; this.portHeld = false; return { exitCode: 0, stdout: '', stderr: '' }; }
            }
            return execFile(cmd, args, options);
        };
        Object.assign(sprite, { proxyPort: (local: number, remote: number, host?: string) => this.proxy(local, remote, host) });
    }

    private resetListen() {
        this.listenPort = new Promise(resolve => { this.resolveListen = resolve; });
    }

    private async start(dir: string) {
        if (this.failStart) throw Object.assign(new Error('sshd failed'), { stderr: 'sshd: no hostkeys available' });
        const read = (name: string) => {
            const file = this.sprite.files.get(`${dir}/${name}`);
            if (!file) throw new Error(`missing ${name}`);
            return file.toString();
        };
        const hostKey = this.hostKeyOverride ?? read('host_key');
        const authorizedKeys = read('authorized_keys');
        const config = read('sshd_config');
        for (const name of ['host_key', 'authorized_keys', 'sshd_config']) this.sprite.files.delete(`${dir}/${name}`);
        this.started.push({ config, authorizedKeys });
        this.sprite.events.push('forward-start');
        const allowed = ssh2.utils.parseKey(authorizedKeys.trim().split(/\s+/).slice(1, 3).join(' ')) as ParsedKey;
        this.server = new ssh2.Server({ hostKeys: [hostKey] }, client => this.accept(client, allowed));
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', () => resolve()));
        this.sshdPort = (this.server.address() as net.AddressInfo).port;
        return { exitCode: 0, stdout: '', stderr: '' };
    }

    private accept(client: Connection, allowed: ParsedKey) {
        this.connections.add(client);
        client.on('close', () => this.connections.delete(client));
        client.on('error', () => {});
        client.on('authentication', ctx => {
            this.authAttempts++;
            this.onAuthentication?.();
            if (ctx.method !== 'publickey' || ctx.username !== SPRITES_MCP_FORWARD_USER
                || ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(['publickey']);
            if (ctx.signature && !allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject(['publickey']);
            ctx.accept();
        });
        client.on('ready', () => {
            client.on('session', (_accept, reject) => reject());
            client.on('tcpip', (_accept, reject) => reject());
            client.on('request', (accept, reject, name, info) => {
                const bind = info as { bindAddr: string; bindPort: number };
                if (name !== 'tcpip-forward') return reject?.();
                this.forwardRequests.push({ bindAddr: bind.bindAddr, bindPort: bind.bindPort });
                if (bind.bindAddr !== SPRITES_MCP_FORWARD_HOST || bind.bindPort !== SPRITES_MCP_FORWARD_PORT) return reject?.();
                this.onForwardRequest?.();
                if (this.portHeld) return reject?.();
                const listener = net.createServer(socket => {
                    client.forwardOut(bind.bindAddr, bind.bindPort, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (error, channel) => {
                        if (error) return socket.destroy();
                        socket.pipe(channel).pipe(socket);
                        socket.on('error', () => channel.destroy());
                        channel.on('error', () => socket.destroy());
                    });
                });
                this.listeners.add(listener);
                client.once('close', () => { listener.close(); this.listeners.delete(listener); this.resetListen(); });
                listener.listen(0, '127.0.0.1', () => {
                    this.resolveListen?.((listener.address() as net.AddressInfo).port);
                    accept?.();
                });
            });
        });
    }

    private async proxy(_local: number, remote: number, host?: string) {
        this.proxies++;
        if (remote !== SPRITES_MCP_SSHD_PORT || host !== SPRITES_MCP_FORWARD_HOST) throw new Error('unexpected proxy target');
        const emitter = new EventEmitter();
        const sockets = new Set<net.Socket>();
        const server = net.createServer(socket => {
            sockets.add(socket);
            if (this.refuseProxy || !this.server) return socket.destroy();
            const upstream = net.connect(this.sshdPort, '127.0.0.1');
            sockets.add(upstream);
            socket.pipe(upstream).pipe(socket);
            const done = () => { socket.destroy(); upstream.destroy(); };
            socket.on('error', done);
            upstream.on('error', done);
            socket.on('close', done);
            upstream.on('close', done);
        });
        await new Promise<void>(resolve => server.listen(0, 'localhost', () => resolve()));
        return Object.assign(emitter, {
            localAddr: () => `localhost:${(server.address() as net.AddressInfo).port}`,
            close: () => { server.close(); for (const socket of sockets) socket.destroy(); },
        });
    }

    /** Drop every live SSH connection, as a lost proxy WebSocket would. */
    drop() {
        for (const client of this.connections) client.end();
    }

    /** A half-open proxy path: the worker loses the connection while sshd keeps the stale session and its listener. */
    dropHalfOpen() {
        this.portHeld = true;
        this.drop();
    }

    stop() {
        this.stops++;
        this.drop();
        for (const listener of this.listeners) listener.close();
        this.server?.close();
        this.server = undefined;
    }
}
