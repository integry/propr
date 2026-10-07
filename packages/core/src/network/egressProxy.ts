import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import type { EgressAllowlist } from './egressAllowlist.js';
import { normalizeEgressHost } from './egressAllowlist.js';
import { connectToFirstAddress, type EgressConnectAttempt } from './egressConnect.js';

/**
 * A per-run HTTP proxy that only opens connections to allowlisted hosts. It
 * accepts `CONNECT host:port` tunnels (HTTPS, git, package managers) and plain
 * HTTP requests in absolute-URI form. Hostnames are resolved here, on the
 * worker, so a container without a network namespace never needs DNS. A
 * worker that itself reaches the internet only through a proxy chains through
 * it: allowed tunnels become CONNECT requests to that proxy.
 *
 * The proxy connects from the worker's network position, which reaches more
 * than an open container does (its loopback, the Compose network). So an
 * allowed name that resolves to a non-public address is refused unless an
 * administrator's IP-literal entry names that address.
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

export type EgressLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

/** How long an upstream (or the worker's proxy) may take to connect and, when chained, to accept the CONNECT. */
export const EGRESS_HANDSHAKE_TIMEOUT_MS = 30_000;

export interface EgressProxyOptions {
    socketPath: string;
    allowlist: EgressAllowlist;
    /**
     * The administrator's own entries: the only ones whose IP literals open a
     * non-public address. Repository entries never do. Defaults to none.
     */
    addressAllowlist?: EgressAllowlist;
    /** Test seam: how a permitted upstream connection (or one to the worker's proxy) is opened. */
    connect?: (port: number, host: string) => net.Socket;
    /** Test seam: how an allowed hostname is resolved on the worker. */
    lookup?: EgressLookup;
    recorder?: EgressDenialRecorder;
    upstreamProxies?: UpstreamProxies;
    /** Bounds connecting and the chained CONNECT handshake only; an established stream has no deadline. */
    handshakeTimeoutMs?: number;
    /** How long one vetted address is tried alone before the next joins it. */
    connectAttemptDelayMs?: number;
}

/**
 * Loopback, unspecified, private (RFC 1918), carrier-grade NAT, link-local,
 * IETF protocol, multicast and reserved IPv4 ranges; IPv6 unspecified,
 * loopback, IPv4-compatible, unique local, link-local and multicast. IPv4
 * rules also match the IPv4-mapped (`::ffff:a.b.c.d`) forms and the IPv4
 * address a well-known NAT64 (`64:ff9b::/96`) address embeds. The benchmarking
 * range (198.18.0.0/15) stays reachable: fake-IP DNS resolvers hand it out for
 * public names.
 */
const NON_PUBLIC_ADDRESSES = (() => {
    const list = new net.BlockList();
    const ipv4: Array<[string, number]> = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
        ['192.0.0.0', 24], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]];
    const ipv6: Array<[string, number]> = [['::', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
    for (const [address, prefix] of ipv4) list.addSubnet(address, prefix, 'ipv4');
    for (const [address, prefix] of ipv6) list.addSubnet(address, prefix, 'ipv6');
    return list;
})();

/** The well-known NAT64 prefix (RFC 6052): `64:ff9b::a.b.c.d` reaches the IPv4 address in its last 32 bits. */
const NAT64_PREFIX = (() => {
    const list = new net.BlockList();
    list.addSubnet('64:ff9b::', 96, 'ipv6');
    return list;
})();

/** The IPv4 address in an IPv6 address's last 32 bits, written either as hex groups or dotted. */
function embeddedIpv4(address: string): string {
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (dotted) return dotted[1];
    const groups = address.split(':');
    const [high, low] = groups.slice(-2).map(group => Number.parseInt(group || '0', 16));
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** Whether an address is one only the worker's own network position reaches (anything not an IP counts). */
export function isNonPublicAddress(address: string): boolean {
    const family = net.isIP(address);
    if (family === 0 || NON_PUBLIC_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4')) return true;
    // A NAT64 worker reaches whatever IPv4 address is embedded; public ones (DNS64 answers) stay usable.
    return family === 6 && NAT64_PREFIX.check(address, 'ipv6') && NON_PUBLIC_ADDRESSES.check(embeddedIpv4(address), 'ipv4');
}

const defaultLookup: EgressLookup = host => dns.lookup(host, { all: true, verbatim: true });

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

/** Where an allowed target is opened: a vetted address, the worker's proxy (which resolves the name), or nowhere. */
type EgressRoute = { addresses?: string[] } | { denied: true } | { unresolved: true };

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
    const lookup = options.lookup ?? defaultLookup;
    const addressAllowlist = options.addressAllowlist ?? { entries: [], allows: () => false };
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? EGRESS_HANDSHAKE_TIMEOUT_MS;
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
        if (allowlist.allows(host, port)) return true;
        recorder.deny(deniedTarget(host, port));
        return false;
    };
    const reachable = (address: string, port: number): boolean => !isNonPublicAddress(address) || addressAllowlist.allows(address, port);
    /**
     * Resolves an allowed hostname once, here, and connects to the vetted
     * address so a second lookup cannot answer differently. Through the
     * worker's proxy the name is sent on (that proxy resolves it, possibly
     * differently: that rebinding window is the proxy's network, not the
     * worker's), but a name that resolves here to a non-public address is
     * still refused; a worker that cannot resolve names leaves it to its proxy.
     */
    const route = async (host: string, port: number, chained: boolean): Promise<EgressRoute> => {
        let route: EgressRoute;
        if (net.isIP(host)) route = reachable(host, port) ? { addresses: [host] } : { denied: true };
        else {
            let addresses: Array<{ address: string }> = [];
            try { addresses = await lookup(host); } catch { /* unresolvable */ }
            route = addresses.some(entry => !reachable(entry.address, port)) ? { denied: true }
                // Every vetted address is kept: the first may be a family the worker has no route for.
                : addresses.length ? { addresses: chained ? undefined : addresses.map(entry => entry.address) }
                : chained ? {} : { unresolved: true };
        }
        if ('denied' in route) recorder.deny(deniedTarget(host, port));
        else recorder.allowed++;
        return route;
    };
    const nonPublicMessage = (host: string): string => `ProPR restricted network: ${host} resolves to a non-public address; only an administrator's IP-literal allowlist entry opens one\n`;
    /** Bounds the connect and handshake phase; cleared once the stream is established. */
    const handshakeDeadline = (onTimeout: () => void): (() => void) => {
        const timer = setTimeout(onTimeout, handshakeTimeoutMs);
        timer.unref?.();
        return () => clearTimeout(timer);
    };
    const connectedEvent = (proxy: URL | undefined): 'secureConnect' | 'connect' => proxy?.protocol === 'https:' ? 'secureConnect' : 'connect';
    /** Opens the worker's proxy, or the first vetted address that answers; the caller's handshake deadline bounds both. */
    const openUpstream = (proxy: URL | undefined, port: number, addresses: string[] | undefined): EgressConnectAttempt => {
        if (!proxy) {
            // close() destroys pending attempts; that must not dial the next address after shutdown.
            const dial = (targetPort: number, address: string): net.Socket => {
                if (shuttingDown) throw new Error('egress proxy closed');
                return connect(targetPort, address);
            };
            return connectToFirstAddress(port, addresses ?? [], { connect: dial, attemptDelayMs: options.connectAttemptDelayMs, track });
        }
        const socket = connectToProxy(proxy);
        track(socket);
        let settled = false;
        const connected = new Promise<net.Socket>((resolve, reject) => {
            const failed = (error?: Error): void => { if (!settled) { settled = true; socket.destroy(); reject(error ?? new Error('upstream connection closed')); } };
            socket.on('error', failed);
            socket.once('close', () => failed());
            socket.once(connectedEvent(proxy), () => { if (!settled) { settled = true; resolve(socket); } });
        });
        return { connected, abort: () => { if (!settled) socket.destroy(); } };
    };

    const server = http.createServer(async (request, response) => {
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
        let clientGone = false;
        response.once('close', () => { clientGone = true; });
        const proxy = viaProxy('http', host, port);
        const target = await route(host, port, !!proxy);
        // The client, or the whole proxy, may have gone while the name was resolved.
        if (clientGone || shuttingDown) { response.destroy(); return; }
        if ('denied' in target) {
            response.writeHead(403, { 'Content-Type': 'text/plain' }).end(nonPublicMessage(host));
            return;
        }
        const upstreamFailed = (status: number, message: string): void => {
            if (response.headersSent) { response.destroy(); return; }
            if (clientGone || shuttingDown) return;
            recorder.fail(deniedTarget(host, port));
            response.writeHead(status, { 'Content-Type': 'text/plain' }).end(`ProPR egress proxy: ${message}\n`);
        };
        if ('unresolved' in target) { upstreamFailed(502, 'upstream connection failed'); return; }
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
        // The allowlisted URL, not the client's Host header, names the upstream site.
        headers.host = url.host;
        const authorization = proxy && proxyAuthorization(proxy);
        if (authorization) headers['proxy-authorization'] = authorization;
        let timedOut = false;
        let attempt: EgressConnectAttempt | undefined;
        const upstream = http.request({
            method: request.method, headers,
            // Through the worker's proxy the request keeps its absolute form.
            path: proxy ? `http://${url.host}${url.pathname}${url.search}` : `${url.pathname}${url.search}`,
            // Tracked like CONNECT upstreams so close() ends them too.
            createConnection: (_options, oncreate) => {
                attempt = openUpstream(proxy, port, target.addresses);
                // Only connecting is bounded: a slow response is the upstream's business.
                const clearDeadline = handshakeDeadline(() => { timedOut = true; attempt?.abort(new Error('upstream connection timed out')); });
                attempt.connected.then(socket => { clearDeadline(); oncreate(null, socket); }, (error: Error) => { clearDeadline(); oncreate(error, undefined as unknown as net.Socket); });
                return undefined;
            },
        }, upstreamResponse => {
            const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
            // An upstream that drops mid-body never ends the pipe; cut the client off so it sees a failed transfer.
            upstreamResponse.on('error', () => response.destroy());
            upstreamResponse.once('close', () => { if (!upstreamResponse.complete) response.destroy(); });
            upstreamResponse.pipe(response);
        });
        // A client that goes away mid-response takes its upstream request with it.
        response.once('close', () => { if (!response.writableFinished) { attempt?.abort(); upstream.destroy(); } });
        upstream.on('error', () => upstreamFailed(timedOut ? 504 : 502, timedOut ? 'upstream connection timed out' : 'upstream connection failed'));
        request.pipe(upstream);
    });

    server.on('connect', async (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
        track(client);
        client.on('error', () => client.destroy());
        const target = parseAuthority(request.url ?? '');
        if (!target) { refuse(client, '400 Bad Request', 'ProPR egress proxy: CONNECT requires host:port\n'); return; }
        if (!permitted(target.host, target.port)) {
            refuse(client, '403 Forbidden', `ProPR restricted network: ${target.host} is not in the allowlist\n`);
            return;
        }
        const proxy = viaProxy('https', target.host, target.port);
        const destination = await route(target.host, target.port, !!proxy);
        // The client, or the whole proxy, may have gone while the name was resolved.
        if (client.destroyed || shuttingDown) { client.destroy(); return; }
        if ('denied' in destination) { refuse(client, '403 Forbidden', nonPublicMessage(target.host)); return; }
        if ('unresolved' in destination) {
            recorder.fail(deniedTarget(target.host, target.port));
            refuse(client, '502 Bad Gateway', 'ProPR egress proxy: upstream connection failed\n');
            return;
        }
        const attempt = openUpstream(proxy, target.port, destination.addresses);
        let upstream: net.Socket | undefined;
        let failed = false, tunnelOpen = false;
        const fail = (status = '502 Bad Gateway', message = 'upstream connection failed'): void => {
            clearDeadline();
            attempt.abort();
            // Once bytes flow, a failure just ends the tunnel; a 502 would corrupt the stream.
            if (tunnelOpen) { client.destroy(); upstream?.destroy(); return; }
            if (failed || client.destroyed || shuttingDown) return;
            failed = true;
            recorder.fail(deniedTarget(target.host, target.port));
            refuse(client, status, `ProPR egress proxy: ${message}\n`);
            upstream?.destroy();
        };
        // Connecting (to every vetted address tried) and the worker proxy's CONNECT answer are bounded; the open tunnel is not.
        const clearDeadline = handshakeDeadline(() => fail('504 Gateway Timeout', 'upstream connection timed out'));
        client.once('close', () => { clearDeadline(); attempt.abort(); upstream?.destroy(); });
        attempt.connected.then(socket => {
            upstream = socket;
            if (failed || client.destroyed || shuttingDown) { socket.destroy(); return; }
            socket.on('error', () => fail());
            // Before the tunnel is up, a closed upstream is a failed connection the client must hear about.
            socket.once('close', () => { if (tunnelOpen) client.destroy(); else fail(); });
            const established = (): void => {
                clearDeadline();
                tunnelOpen = true;
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head?.length) socket.write(head);
                socket.pipe(client);
                client.pipe(socket);
            };
            if (proxy) tunnelThroughProxy(socket, proxy, `${net.isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${target.port}`, { established, fail: () => fail() });
            else established();
        }, () => fail());
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
