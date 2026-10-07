import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileEgressAllowlist, parseEgressAllowEntry, baseEgressAllowlist, validateEgressAllowlist } from '../src/network/egressAllowlist.js';
import { EgressDenialRecorder, bypassesUpstreamProxy, parseAuthority, startEgressProxy, upstreamProxiesFromEnv } from '../src/network/egressProxy.js';

const directories: string[] = [];
after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

async function socketPath(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'egress-'));
    directories.push(directory);
    return path.join(directory, 'proxy.sock');
}

/** A local TCP server standing in for an allowed upstream host. */
async function upstreamServer(handler: (socket: net.Socket) => void): Promise<{ port: number; close(): Promise<void> }> {
    const server = net.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as net.AddressInfo).port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Sends CONNECT through the proxy socket and returns the status line plus the open socket. */
function connectThrough(proxySocket: string, authority: string): Promise<{ status: string; socket: net.Socket; rest: string }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxySocket);
        let buffered = '';
        socket.on('error', reject);
        socket.on('data', function onData(chunk) {
            buffered += chunk.toString('utf8');
            const end = buffered.indexOf('\r\n\r\n');
            if (end < 0) return;
            socket.off('data', onData);
            resolve({ status: buffered.split('\r\n')[0], socket, rest: buffered.slice(end + 4) });
        });
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
}

function readMore(socket: net.Socket, initial: string, expected: string): Promise<string> {
    return new Promise(resolve => {
        let buffered = initial;
        if (buffered.includes(expected)) { resolve(buffered); return; }
        socket.on('data', chunk => {
            buffered += chunk.toString('utf8');
            if (buffered.includes(expected)) resolve(buffered);
        });
    });
}

test('allowlist entries match exact hosts, wildcard subdomains and default ports only', () => {
    const allowlist = compileEgressAllowlist(['registry.npmjs.org', '*.internal.example.com', 'git.example.com:8443', '10.0.0.5']);
    assert.ok(allowlist.allows('registry.npmjs.org', 443));
    assert.ok(allowlist.allows('REGISTRY.npmjs.org.', 80), 'case and a trailing dot are normalized');
    assert.ok(!allowlist.allows('registry.npmjs.org', 22), 'other ports need an explicit entry');
    assert.ok(!allowlist.allows('evil-registry.npmjs.org', 443));
    assert.ok(allowlist.allows('a.internal.example.com', 443));
    assert.ok(allowlist.allows('a.b.internal.example.com', 443));
    assert.ok(!allowlist.allows('internal.example.com', 443), 'a wildcard does not include the apex');
    assert.ok(!allowlist.allows('xinternal.example.com', 443));
    assert.ok(allowlist.allows('git.example.com', 8443));
    assert.ok(!allowlist.allows('git.example.com', 443), 'an entry with a port allows only that port');
    assert.ok(allowlist.allows('10.0.0.5', 443), 'an allowlisted IP literal is allowed');
    assert.ok(!allowlist.allows('10.0.0.6', 443));
    assert.ok(!allowlist.allows('140.82.112.3', 443), 'IP literals are denied unless allowlisted, even for allowed hostnames');
});

test('wildcards never match IP literals and malformed entries are rejected', () => {
    assert.ok(!compileEgressAllowlist(['*.0.0.1']).allows('127.0.0.1', 443));
    for (const entry of ['*', '*.com', 'a*.example.com', 'example', '', 'host:0', 'host:99999', 'bad_host.example.com', '-a.example.com']) {
        assert.equal(typeof parseEgressAllowEntry(entry), 'string', entry);
    }
    assert.deepEqual(parseEgressAllowEntry('[::1]:8080'), { host: '::1', wildcard: false, port: 8080 });
    assert.equal(validateEgressAllowlist('registry.npmjs.org', 'network.allow'), 'network.allow must be an array of at most 500 hostnames');
    assert.match(validateEgressAllowlist(['ok.example.com', '*'], 'network.allow')!, /network\.allow\[1\]/);
});

test('every agent base list covers GitHub and the package registries', () => {
    for (const agent of ['claude', 'codex', 'antigravity', 'opencode', 'vibe'] as const) {
        const hosts = baseEgressAllowlist(agent);
        for (const host of ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']) {
            assert.ok(hosts.includes(host), `${agent}: ${host}`);
        }
    }
    // Set membership rather than Array#includes, which CodeQL mistakes for URL substring checks.
    assert.ok(new Set(baseEgressAllowlist('claude')).has('api.anthropic.com'));
    assert.ok(new Set(baseEgressAllowlist('codex')).has('api.openai.com'));
    assert.ok(new Set(baseEgressAllowlist('vibe')).has('api.mistral.ai'));
});

test('CONNECT authorities are parsed with ports and IPv6 brackets', () => {
    assert.deepEqual(parseAuthority('Example.com:443'), { host: 'example.com', port: 443 });
    assert.deepEqual(parseAuthority('[::1]:22'), { host: '::1', port: 22 });
    assert.equal(parseAuthority('example.com'), null);
    assert.equal(parseAuthority('example.com:0'), null);
});

test('an allowed host is tunnelled; a denied host gets 403 and is recorded', async () => {
    const upstream = await upstreamServer(socket => socket.on('data', chunk => socket.write(`echo:${chunk}`)));
    const connected: string[] = [];
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist([`allowed.example.com:${upstream.port}`]),
        // Resolve the allowed name to the local stand-in instead of DNS.
        connect: (port, host) => { connected.push(`${host}:${port}`); return net.connect({ port, host: '127.0.0.1' }); },
    });
    try {
        const allowed = await connectThrough(proxy.socketPath, `allowed.example.com:${upstream.port}`);
        assert.equal(allowed.status, 'HTTP/1.1 200 Connection Established');
        allowed.socket.write('ping');
        assert.match(await readMore(allowed.socket, allowed.rest, 'echo:ping'), /echo:ping/);
        allowed.socket.destroy();

        const denied = await connectThrough(proxy.socketPath, 'exfiltrate.example.net:443');
        assert.equal(denied.status, 'HTTP/1.1 403 Forbidden');
        denied.socket.destroy();
        const deniedAgain = await connectThrough(proxy.socketPath, 'exfiltrate.example.net:443');
        assert.equal(deniedAgain.status, 'HTTP/1.1 403 Forbidden');
        deniedAgain.socket.destroy();
        const ipLiteral = await connectThrough(proxy.socketPath, `127.0.0.1:${upstream.port}`);
        assert.equal(ipLiteral.status, 'HTTP/1.1 403 Forbidden', 'an IP literal outside the allowlist is denied');
        ipLiteral.socket.destroy();

        assert.deepEqual(connected, [`allowed.example.com:${upstream.port}`], 'denied targets are never connected');
        const stats = proxy.stats();
        assert.equal(stats.allowedConnections, 1);
        assert.equal(stats.deniedConnections, 3);
        assert.deepEqual(stats.deniedHosts, [{ host: 'exfiltrate.example.net', count: 2 }, { host: `127.0.0.1:${upstream.port}`, count: 1 }]);
    } finally {
        await proxy.close();
        await upstream.close();
    }
});

test('plain HTTP requests in absolute form are forwarded only to allowed hosts', async () => {
    // Record what arrived upstream instead of echoing it, so the response never reflects request data.
    const received: string[] = [];
    const server = http.createServer((request, response) => {
        received.push(`${request.url} ${request.headers['proxy-authorization'] ?? 'no-proxy-auth'}`);
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('hello');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist([`mirror.example.com:${port}`]),
        connect: (targetPort) => net.connect({ port: targetPort, host: '127.0.0.1' }),
    });
    const request = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({ socketPath: proxy.socketPath, path: url, headers: { 'Proxy-Authorization': 'Basic secret' } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
    try {
        const allowed = await request(`http://mirror.example.com:${port}/simple/?q=1`);
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body, 'hello');
        assert.deepEqual(received, ['/simple/?q=1 no-proxy-auth'], 'proxy credentials are not forwarded upstream');
        const denied = await request('http://pastebin.example.org/upload');
        assert.equal(denied.status, 403);
        assert.match(denied.body, /pastebin\.example\.org is not in the allowlist/);
        assert.deepEqual(proxy.stats().deniedHosts, [{ host: 'pastebin.example.org', count: 1 }]);
    } finally {
        await proxy.close();
        await new Promise(resolve => server.close(resolve));
    }
});

test('plain HTTP requests carry the target URL authority as Host, whatever Host the client sent', async () => {
    // Routes by Host like a virtual-hosting upstream: any other site is unknown.
    let expectedHost = '';
    const received: string[] = [];
    const server = http.createServer((request, response) => {
        received.push(`${request.headers.host}${request.url}`);
        if (request.headers.host !== expectedHost) { response.writeHead(421, { 'Content-Type': 'text/plain' }).end('unknown site'); return; }
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('site');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist(['vhost.example.com', `vhost.example.com:${port}`]),
        connect: () => net.connect({ port, host: '127.0.0.1' }),
    });
    const request = (url: string, host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = http.request({ socketPath: proxy.socketPath, path: url, headers: { Host: host } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
    try {
        expectedHost = `vhost.example.com:${port}`;
        const withPort = await request(`http://vhost.example.com:${port}/a?b=1`, 'proxy.invalid');
        assert.deepEqual(withPort, { status: 200, body: 'site' });
        assert.equal(received.at(-1), `vhost.example.com:${port}/a?b=1`, 'a non-default port stays in the forwarded authority');
        expectedHost = 'vhost.example.com';
        const defaultPort = await request('http://vhost.example.com/index', 'other.example.org');
        assert.deepEqual(defaultPort, { status: 200, body: 'site' });
        assert.equal(received.at(-1), 'vhost.example.com/index', 'the default port is left out of the forwarded authority');
    } finally {
        await proxy.close();
        await new Promise(resolve => server.close(resolve));
    }
});

test('an unfinished plain HTTP response ends its upstream when the client leaves or the proxy closes', async () => {
    const upstreamClosed: Array<Promise<void>> = [];
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('first chunk\n'); // and never ends
    });
    server.on('connection', socket => upstreamClosed.push(new Promise(resolve => socket.once('close', () => resolve()))));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist([`stream.example.com:${port}`]),
        connect: (targetPort) => net.connect({ port: targetPort, host: '127.0.0.1' }),
    });
    const streaming = () => new Promise<http.ClientRequest>((resolve, reject) => {
        const outgoing = http.request({ socketPath: proxy.socketPath, path: `http://stream.example.com:${port}/events` }, response => {
            response.once('data', () => resolve(outgoing));
        });
        outgoing.on('error', () => undefined);
        outgoing.once('error', reject);
        outgoing.end();
    });
    const within = (promise: Promise<void>, message: string) => Promise.race([
        promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 2000).unref()),
    ]);
    try {
        const disconnecting = await streaming();
        disconnecting.destroy();
        await within(upstreamClosed[0], 'upstream stayed open after the client disconnected');

        await streaming();
        await proxy.close();
        await within(upstreamClosed[1], 'upstream stayed open after the proxy closed');
    } finally {
        await proxy.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('a plain HTTP response the upstream drops mid-body ends the client response as interrupted', async () => {
    const closeRequests = await Promise.all(['length', 'chunked'].map(async framing => {
        const upstream = await upstreamServer(socket => socket.once('data', () => {
            const head = framing === 'length' ? 'Content-Length: 1000\r\n' : 'Transfer-Encoding: chunked\r\n';
            const body = framing === 'length' ? 'partial body' : 'c\r\npartial body\r\n';
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n${head}\r\n${body}`, () => setTimeout(() => socket.destroy(), 50));
        }));
        const proxy = await startEgressProxy({
            socketPath: await socketPath(),
            allowlist: compileEgressAllowlist([`flaky.example.com:${upstream.port}`]),
            connect: (targetPort) => net.connect({ port: targetPort, host: '127.0.0.1' }),
        });
        try {
            const outcome = await Promise.race([
                new Promise<string>(resolve => {
                    const outgoing = http.request({ socketPath: proxy.socketPath, path: `http://flaky.example.com:${upstream.port}/download` }, response => {
                        let body = '';
                        response.on('data', chunk => { body += chunk; });
                        response.on('end', () => resolve(`completed:${body}`));
                        response.on('error', () => resolve(`interrupted:${body}`));
                    });
                    outgoing.on('error', () => resolve('interrupted:'));
                    outgoing.end();
                }),
                new Promise<string>(resolve => setTimeout(() => resolve('hung'), 2000).unref()),
            ]);
            assert.match(outcome, /^interrupted:/, `${framing}: the client must see the transfer fail promptly, got ${outcome}`);
        } finally {
            await proxy.close();
        }
        return upstream.close;
    }));
    await Promise.all(closeRequests.map(close => close()));
});

test('the worker proxy variables and NO_PROXY decide which allowed connections chain through the worker proxy', () => {
    const proxies = upstreamProxiesFromEnv({ HTTPS_PROXY: 'http://user:p%40ss@corp.example.com:3128', http_proxy: 'corp-http.example.com:8080', NO_PROXY: 'internal.example.com, .svc.local,mirror.example.com:8443,' });
    assert.equal(proxies.https?.href, 'http://user:p%40ss@corp.example.com:3128/');
    assert.equal(proxies.http?.href, 'http://corp-http.example.com:8080/', 'a scheme-less value is an http proxy');
    assert.deepEqual(proxies.noProxy, ['internal.example.com', '.svc.local', 'mirror.example.com:8443']);
    assert.equal(upstreamProxiesFromEnv({ HTTP_PROXY: 'http://only-http.example.com:3128' }).https?.hostname, 'only-http.example.com', 'tunnels fall back to the HTTP proxy');
    assert.deepEqual(upstreamProxiesFromEnv({ HTTPS_PROXY: 'socks5://x:1080' }), { http: undefined, https: undefined, noProxy: [] }, 'only HTTP(S) proxies can carry CONNECT');
    assert.ok(bypassesUpstreamProxy('internal.example.com', 443, proxies.noProxy));
    assert.ok(bypassesUpstreamProxy('git.internal.example.com', 443, proxies.noProxy));
    assert.ok(bypassesUpstreamProxy('api.svc.local', 80, proxies.noProxy));
    assert.ok(bypassesUpstreamProxy('mirror.example.com', 8443, proxies.noProxy));
    assert.ok(!bypassesUpstreamProxy('mirror.example.com', 443, proxies.noProxy), 'an entry with a port bypasses only that port');
    assert.ok(!bypassesUpstreamProxy('notinternal.example.com', 443, proxies.noProxy));
    assert.ok(bypassesUpstreamProxy('anything.example.org', 443, ['*']));
});

/** A worker-side proxy that accepts CONNECT (checking credentials) and absolute-form HTTP, recording what it saw. */
async function workerProxyServer(targetPort: number, options: { refuse?: boolean } = {}) {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
        seen.push(`${request.method} ${request.url} ${request.headers['proxy-authorization'] ?? 'no-auth'}`);
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('via-worker-proxy');
    });
    server.on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
        seen.push(`CONNECT ${request.url} ${request.headers['proxy-authorization'] ?? 'no-auth'}`);
        if (options.refuse) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
        const target = net.connect({ port: targetPort, host: '127.0.0.1' }, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            target.pipe(socket);
            socket.pipe(target);
        });
        target.on('error', () => socket.destroy());
        socket.on('error', () => target.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        seen, port: (server.address() as net.AddressInfo).port,
        close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); },
    };
}

test('allowed connections chain through the worker proxy, honouring NO_PROXY, and its refusals are recorded as failures', async () => {
    const upstream = await upstreamServer(socket => socket.on('data', () => socket.write('upstream-reply')));
    const workerProxy = await workerProxyServer(upstream.port);
    const refusingProxy = await workerProxyServer(upstream.port, { refuse: true });
    const connected: string[] = [];
    const start = async (proxyPort: number) => startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist(['api.example.com', 'direct.example.com:' + upstream.port, 'plain.example.com']),
        connect: (port, host) => { connected.push(`${host}:${port}`); return net.connect({ port, host: '127.0.0.1' }); },
        upstreamProxies: { http: new URL(`http://user:secret@127.0.0.1:${proxyPort}`), https: new URL(`http://user:secret@127.0.0.1:${proxyPort}`), noProxy: ['direct.example.com'] },
    });
    const proxy = await start(workerProxy.port);
    const refused = await start(refusingProxy.port);
    const basic = `Basic ${Buffer.from('user:secret').toString('base64')}`;
    try {
        const chained = await connectThrough(proxy.socketPath, 'api.example.com:443');
        assert.equal(chained.status, 'HTTP/1.1 200 Connection Established');
        chained.socket.write('hello');
        assert.match(await readMore(chained.socket, chained.rest, 'upstream-reply'), /upstream-reply/);
        chained.socket.destroy();
        assert.deepEqual(workerProxy.seen, [`CONNECT api.example.com:443 ${basic}`], 'the worker proxy receives the allowed authority with its credentials');

        const direct = await connectThrough(proxy.socketPath, `direct.example.com:${upstream.port}`);
        assert.equal(direct.status, 'HTTP/1.1 200 Connection Established');
        direct.socket.destroy();
        assert.equal(workerProxy.seen.length, 1, 'a NO_PROXY host is reached directly');
        assert.deepEqual(connected, [`127.0.0.1:${workerProxy.port}`, `direct.example.com:${upstream.port}`]);

        const plain = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const outgoing = http.request({ socketPath: proxy.socketPath, path: 'http://plain.example.com/simple/' }, response => {
                let body = '';
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
            });
            outgoing.on('error', reject);
            outgoing.end();
        });
        assert.deepEqual(plain, { status: 200, body: 'via-worker-proxy' });
        assert.equal(workerProxy.seen[1], `GET http://plain.example.com/simple/ ${basic}`, 'plain HTTP keeps its absolute form through the worker proxy');
        assert.equal(proxy.stats().failedConnections, 0);

        const blocked = await connectThrough(refused.socketPath, 'api.example.com:443');
        assert.equal(blocked.status, 'HTTP/1.1 502 Bad Gateway');
        blocked.socket.destroy();
        const stats = refused.stats();
        assert.equal(stats.allowedConnections, 1);
        assert.equal(stats.failedConnections, 1, 'an allowed connection the worker proxy refused is not silently counted as a success');
        assert.deepEqual(stats.failedHosts, [{ host: 'api.example.com', count: 1 }]);
    } finally {
        await proxy.close();
        await refused.close();
        await workerProxy.close();
        await refusingProxy.close();
        await upstream.close();
    }
});

test('an allowed host that cannot be reached is answered 502 and recorded as a failed connection', async () => {
    const closed = await upstreamServer(socket => socket.destroy());
    await closed.close();
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist([`down.example.com:${closed.port}`]),
        connect: (port) => net.connect({ port, host: '127.0.0.1' }),
    });
    try {
        const tunnel = await connectThrough(proxy.socketPath, `down.example.com:${closed.port}`);
        assert.equal(tunnel.status, 'HTTP/1.1 502 Bad Gateway');
        tunnel.socket.destroy();
        const status = await new Promise<number>((resolve, reject) => {
            const outgoing = http.request({ socketPath: proxy.socketPath, path: `http://down.example.com:${closed.port}/` }, response => { response.resume(); resolve(response.statusCode ?? 0); });
            outgoing.on('error', reject);
            outgoing.end();
        });
        assert.equal(status, 502);
        assert.deepEqual(proxy.stats().failedHosts, [{ host: `down.example.com:${closed.port}`, count: 2 }]);
    } finally {
        await proxy.close();
    }
});

test('denials past the named-host limit are still counted, never dropped', () => {
    const recorder = new EgressDenialRecorder(2);
    for (const host of ['a.example.com', 'b.example.com', 'c.example.com', 'c.example.com', 'd.example.com', 'a.example.com']) recorder.deny(host);
    const stats = recorder.stats();
    assert.deepEqual(stats.deniedHosts, [{ host: 'a.example.com', count: 2 }, { host: 'b.example.com', count: 1 }]);
    assert.equal(stats.omittedDeniedHosts, 2);
    assert.equal(stats.omittedDeniedAttempts, 3);
    assert.equal(stats.deniedConnections, 6);
});
