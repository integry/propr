import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import type { EgressAllowlist } from './egressAllowlist.js';
import { normalizeEgressHost } from './egressAllowlist.js';

/**
 * A per-run HTTP proxy that only opens connections to allowlisted hosts. It
 * accepts `CONNECT host:port` tunnels (HTTPS, git, package managers) and plain
 * HTTP requests in absolute-URI form. Hostnames are resolved here, on the
 * worker, so a container without a network namespace never needs DNS. A
 * worker that itself reaches the internet only through a proxy chains through
 * it: allowed tunnels become CONNECT requests to that proxy.
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
    /** Allowed connections the upstream (or the worker's proxy) refused or never answered. */
    failedConnections: number;
    failedHosts: EgressDeniedHost[];
}

export class EgressDenialRecorder {
    private readonly hosts = new Map<string, number>();
    private readonly omitted = new Set<string>();
    private omittedAttempts = 0;
    private readonly failures = new Map<string, number>();
    private failed = 0;
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

    /** An allowed target that could not be reached: with a mandatory worker proxy, the only sign of a misconfiguration. */
    fail(target: string): void {
        this.failed++;
        if (this.failures.has(target) || this.failures.size < this.limit) this.failures.set(target, (this.failures.get(target) ?? 0) + 1);
    }

    stats(): EgressProxyStats {
        const deniedHosts = [...this.hosts].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
        return {
            allowedConnections: this.allowed,
            deniedConnections: deniedHosts.reduce((total, entry) => total + entry.count, 0) + this.omittedAttempts,
            deniedHosts,
            omittedDeniedHosts: this.omitted.size,
            omittedDeniedAttempts: this.omittedAttempts,
            failedConnections: this.failed,
            failedHosts: [...this.failures].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
        };
    }
}

export interface EgressProxy {
    readonly socketPath: string;
    stats(): EgressProxyStats;
    close(): Promise<void>;
}

/** The worker's own outbound proxies, from its standard proxy variables. */
export interface UpstreamProxies {
    /** For plain http:// requests. */
    http?: URL;
    /** For CONNECT tunnels. */
    https?: URL;
    /** NO_PROXY entries: hosts reached directly. */
    noProxy: string[];
}

export interface EgressProxyOptions {
    socketPath: string;
    allowlist: EgressAllowlist;
    /** Test seam: how a permitted upstream connection (or one to the worker's proxy) is opened. */
    connect?: (port: number, host: string) => net.Socket;
    recorder?: EgressDenialRecorder;
    upstreamProxies?: UpstreamProxies;
}

function proxyUrl(value: string | undefined): URL | undefined {
    if (!value?.trim()) return undefined;
    try {
        const url = new URL(value.includes('://') ? value.trim() : `http://${value.trim()}`);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
    } catch { return undefined; }
}

/** `http_proxy`/`HTTP_PROXY`, `https_proxy`/`HTTPS_PROXY` (falling back to the HTTP proxy) and `no_proxy`/`NO_PROXY`. */
export function upstreamProxiesFromEnv(env: NodeJS.ProcessEnv = process.env): UpstreamProxies {
    const http = proxyUrl(env.http_proxy || env.HTTP_PROXY);
    return {
        http,
        https: proxyUrl(env.https_proxy || env.HTTPS_PROXY) ?? http,
        noProxy: (env.no_proxy || env.NO_PROXY || '').split(/[\s,]+/).map(entry => entry.trim().toLowerCase()).filter(Boolean),
    };
}

/** NO_PROXY semantics shared by curl and most clients: `*`, exact names, and domain suffixes (`.example.com` or `example.com`). */
export function bypassesUpstreamProxy(host: string, port: number, noProxy: readonly string[]): boolean {
    return noProxy.some(entry => {
        if (entry === '*') return true;
        const target = parseAuthority(entry) ?? { host: normalizeEgressHost(entry), port: undefined };
        if (target.port !== undefined && target.port !== port) return false;
        const domain = target.host.replace(/^\*?\./, '');
        return !!domain && (host === domain || host.endsWith(`.${domain}`));
    });
}

function proxyAuthorization(proxy: URL): string | undefined {
    return proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
}

const proxyPort = (proxy: URL): number => Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);

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

/** Sends `CONNECT authority` to the worker's proxy on an open socket and waits for its 2xx answer. */
function tunnelThroughProxy(socket: net.Socket, proxy: URL, authority: string, { established, fail }: { established(): void; fail(): void }): void {
    const authorization = proxyAuthorization(proxy);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''}\r\n`);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) { if (buffered.length > 16_384) { socket.off('data', onData); fail(); } return; }
        socket.off('data', onData);
        socket.pause();
        if (!/^HTTP\/1\.[01] 2\d\d /.test(buffered.subarray(0, end).toString('latin1'))) { fail(); return; }
        if (buffered.length > end + 4) socket.unshift(buffered.subarray(end + 4));
        established();
    };
    socket.on('data', onData);
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
    const { socketPath, allowlist } = options;
    const connect = options.connect ?? ((port: number, host: string) => net.connect({ port, host }));
    const upstreamProxies = options.upstreamProxies ?? { noProxy: [] };
    const viaProxy = (kind: 'http' | 'https', host: string, port: number): URL | undefined => {
        const proxy = upstreamProxies[kind];
        return proxy && !bypassesUpstreamProxy(host, port, upstreamProxies.noProxy) ? proxy : undefined;
    };
    const connectToProxy = (proxy: URL): net.Socket => proxy.protocol === 'https:'
        ? tls.connect({ host: proxy.hostname, port: proxyPort(proxy), servername: net.isIP(proxy.hostname) ? undefined : proxy.hostname })
        : connect(proxyPort(proxy), proxy.hostname.replace(/^\[|\]$/g, ''));
    const recorder = options.recorder ?? new EgressDenialRecorder();
    const open = new Set<Duplex>();
    let shuttingDown = false;
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
        const proxy = viaProxy('http', host, port);
        const authorization = proxy && proxyAuthorization(proxy);
        if (authorization) headers['proxy-authorization'] = authorization;
        const upstream = http.request({
            method: request.method, headers,
            // Through the worker's proxy the request keeps its absolute form.
            path: proxy ? `http://${url.host}${url.pathname}${url.search}` : `${url.pathname}${url.search}`,
            // Tracked like CONNECT upstreams so close() ends them too.
            createConnection: () => { const socket = proxy ? connectToProxy(proxy) : connect(port, host); track(socket); return socket; },
        }, upstreamResponse => {
            const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
            // An upstream that drops mid-body never ends the pipe; cut the client off so it sees a failed transfer.
            upstreamResponse.on('error', () => response.destroy());
            upstreamResponse.once('close', () => { if (!upstreamResponse.complete) response.destroy(); });
            upstreamResponse.pipe(response);
        });
        // A client that goes away mid-response takes its upstream request with it.
        let clientGone = false;
        response.once('close', () => { clientGone = true; if (!response.writableFinished) upstream.destroy(); });
        upstream.on('error', () => {
            if (response.headersSent) { response.destroy(); return; }
            if (clientGone || shuttingDown) return;
            recorder.fail(deniedTarget(host, port));
            response.writeHead(502, { 'Content-Type': 'text/plain' }).end('ProPR egress proxy: upstream connection failed\n');
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
        const proxy = viaProxy('https', target.host, target.port);
        const upstream = proxy ? connectToProxy(proxy) : connect(target.port, target.host);
        track(upstream);
        let failed = false, tunnelOpen = false;
        const fail = (): void => {
            // Once bytes flow, a failure just ends the tunnel; a 502 would corrupt the stream.
            if (tunnelOpen) { client.destroy(); upstream.destroy(); return; }
            if (failed || client.destroyed || shuttingDown) return;
            failed = true;
            recorder.fail(deniedTarget(target.host, target.port));
            refuse(client, '502 Bad Gateway', 'ProPR egress proxy: upstream connection failed\n');
            upstream.destroy();
        };
        upstream.on('error', fail);
        upstream.once(proxy?.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
            const established = (): void => {
                tunnelOpen = true;
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head?.length) upstream.write(head);
                upstream.pipe(client);
                client.pipe(upstream);
            };
            if (proxy) tunnelThroughProxy(upstream, proxy, `${net.isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}`, { established, fail });
            else established();
        });
        client.once('close', () => upstream.destroy());
        // Before the tunnel is up, a closed upstream is a failed connection the client must hear about.
        upstream.once('close', () => { if (tunnelOpen) client.destroy(); else fail(); });
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
            shuttingDown = true;
            closing ??= new Promise<void>(resolve => {
                server.close(() => resolve());
                for (const socket of open) socket.destroy();
            }).then(() => fs.rm(socketPath, { force: true }));
            return closing;
        },
    };
}
