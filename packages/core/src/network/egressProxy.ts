import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import type { EgressAllowlist } from './egressAllowlist.js';
import { normalizeEgressHost } from './egressAllowlist.js';

/**
 * A per-run HTTP proxy that only opens connections to allowlisted hosts. It
 * accepts `CONNECT host:port` tunnels (HTTPS, git, package managers) and plain
 * HTTP requests in absolute-URI form. Hostnames are resolved here, on the
 * worker, so a container without a network namespace never needs DNS.
 */

/** Distinct denied hosts kept by name; the rest are still counted. */
export const EGRESS_DENIED_HOST_LIMIT = 100;

export interface EgressDeniedHost { host: string; count: number }
export interface EgressProxyStats {
    allowedConnections: number;
    deniedConnections: number;
    deniedHosts: EgressDeniedHost[];
    /** Distinct denied hosts beyond {@link EGRESS_DENIED_HOST_LIMIT}, and their attempts. */
    omittedDeniedHosts: number;
    omittedDeniedAttempts: number;
}

export class EgressDenialRecorder {
    private readonly hosts = new Map<string, number>();
    private readonly omitted = new Set<string>();
    private omittedAttempts = 0;
    allowed = 0;

    constructor(private readonly limit = EGRESS_DENIED_HOST_LIMIT) {}

    deny(target: string): void {
        const count = this.hosts.get(target);
        if (count !== undefined) { this.hosts.set(target, count + 1); return; }
        if (this.hosts.size < this.limit) { this.hosts.set(target, 1); return; }
        // Never drop a denial: beyond the named limit it is still counted.
        if (this.omitted.size < 100_000) this.omitted.add(target);
        this.omittedAttempts++;
    }

    stats(): EgressProxyStats {
        const deniedHosts = [...this.hosts].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
        return {
            allowedConnections: this.allowed,
            deniedConnections: deniedHosts.reduce((total, entry) => total + entry.count, 0) + this.omittedAttempts,
            deniedHosts,
            omittedDeniedHosts: this.omitted.size,
            omittedDeniedAttempts: this.omittedAttempts,
        };
    }
}

export interface EgressProxy {
    readonly socketPath: string;
    stats(): EgressProxyStats;
    close(): Promise<void>;
}

export interface EgressProxyOptions {
    socketPath: string;
    allowlist: EgressAllowlist;
    /** Test seam: how a permitted upstream connection is opened. */
    connect?: (port: number, host: string) => net.Socket;
    recorder?: EgressDenialRecorder;
}

/** Splits `host:port` / `[v6]:port` from a CONNECT authority. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:[\]]+):(\d+)$/.exec(authority);
    if (!match) return null;
    const port = Number(match[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    const host = normalizeEgressHost(match[1]);
    return host ? { host, port } : null;
}

/** Denials are keyed by host, with the port only when it is not 80 or 443. */
function deniedTarget(host: string, port: number): string {
    const name = net.isIP(host) === 6 ? `[${host}]` : host;
    return port === 80 || port === 443 ? name : `${name}:${port}`;
}

function refuse(socket: Duplex, status: string, message: string): void {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
    const { socketPath, allowlist } = options;
    const connect = options.connect ?? ((port: number, host: string) => net.connect({ port, host }));
    const recorder = options.recorder ?? new EgressDenialRecorder();
    const open = new Set<Duplex>();
    const track = (socket: Duplex): void => { open.add(socket); socket.once('close', () => open.delete(socket)); };
    const permitted = (host: string, port: number): boolean => {
        if (allowlist.allows(host, port)) { recorder.allowed++; return true; }
        recorder.deny(deniedTarget(host, port));
        return false;
    };

    const server = http.createServer((request, response) => {
        let url: URL;
        try { url = new URL(request.url ?? ''); } catch {
            response.writeHead(400, { 'Content-Type': 'text/plain' }).end('ProPR egress proxy: absolute-form request URL required\n');
            return;
        }
        if (url.protocol !== 'http:') {
            response.writeHead(400, { 'Content-Type': 'text/plain' }).end('ProPR egress proxy: only http:// requests are forwarded; use CONNECT for https\n');
            return;
        }
        const host = normalizeEgressHost(url.hostname);
        const port = url.port ? Number(url.port) : 80;
        if (!permitted(host, port)) {
            response.writeHead(403, { 'Content-Type': 'text/plain' }).end(`ProPR restricted network: ${host} is not in the allowlist\n`);
            return;
        }
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
        // The allowlisted URL, not the client's Host header, names the upstream site.
        headers.host = url.host;
        const upstream = http.request({
            host, port, method: request.method, path: `${url.pathname}${url.search}`, headers,
            // Tracked like CONNECT upstreams so close() ends them too.
            createConnection: () => { const socket = connect(port, host); track(socket); return socket; },
        }, upstreamResponse => {
            const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
            upstreamResponse.pipe(response);
        });
        // A client that goes away mid-response takes its upstream request with it.
        response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
        upstream.on('error', () => {
            if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' }).end('ProPR egress proxy: upstream connection failed\n');
            else response.destroy();
        });
        request.pipe(upstream);
    });

    server.on('connect', (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
        track(client);
        client.on('error', () => client.destroy());
        const target = parseAuthority(request.url ?? '');
        if (!target) { refuse(client, '400 Bad Request', 'ProPR egress proxy: CONNECT requires host:port\n'); return; }
        if (!permitted(target.host, target.port)) {
            refuse(client, '403 Forbidden', `ProPR restricted network: ${target.host} is not in the allowlist\n`);
            return;
        }
        const upstream = connect(target.port, target.host);
        track(upstream);
        upstream.once('connect', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => {
            refuse(client, '502 Bad Gateway', 'ProPR egress proxy: upstream connection failed\n');
            upstream.destroy();
        });
        client.once('close', () => upstream.destroy());
        upstream.once('close', () => client.destroy());
    });
    server.on('connection', socket => track(socket));
    server.on('clientError', (_error, socket) => refuse(socket, '400 Bad Request', ''));

    await fs.rm(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    // Container users differ from the worker's (and may be user-namespace mapped).
    await fs.chmod(socketPath, 0o666);

    let closing: Promise<void> | undefined;
    return {
        socketPath,
        stats: () => recorder.stats(),
        close() {
            closing ??= new Promise<void>(resolve => {
                server.close(() => resolve());
                for (const socket of open) socket.destroy();
            }).then(() => fs.rm(socketPath, { force: true }));
            return closing;
        },
    };
}
