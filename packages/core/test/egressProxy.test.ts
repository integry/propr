import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileEgressAllowlist, parseEgressAllowEntry, baseEgressAllowlist, validateEgressAllowlist } from '../src/network/egressAllowlist.js';
import { EgressDenialRecorder, parseAuthority, startEgressProxy } from '../src/network/egressProxy.js';

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
    assert.ok(baseEgressAllowlist('claude').includes('api.anthropic.com'));
    assert.ok(baseEgressAllowlist('codex').includes('api.openai.com'));
    assert.ok(baseEgressAllowlist('vibe').includes('api.mistral.ai'));
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
    const server = http.createServer((request, response) => response.end(`hello ${request.url} ${request.headers['proxy-authorization'] ?? 'no-proxy-auth'}`));
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
        assert.equal(allowed.body, 'hello /simple/?q=1 no-proxy-auth', 'proxy credentials are not forwarded upstream');
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
    const server = http.createServer((request, response) => {
        if (request.headers.host !== expectedHost) { response.writeHead(421).end(`unknown site ${request.headers.host}`); return; }
        response.end(`site ${request.headers.host}${request.url}`);
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
        assert.deepEqual(withPort, { status: 200, body: `site vhost.example.com:${port}/a?b=1` }, 'a non-default port stays in the forwarded authority');
        expectedHost = 'vhost.example.com';
        const defaultPort = await request('http://vhost.example.com/index', 'other.example.org');
        assert.deepEqual(defaultPort, { status: 200, body: 'site vhost.example.com/index' }, 'the default port is left out of the forwarded authority');
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

test('denials past the named-host limit are still counted, never dropped', () => {
    const recorder = new EgressDenialRecorder(2);
    for (const host of ['a.example.com', 'b.example.com', 'c.example.com', 'c.example.com', 'd.example.com', 'a.example.com']) recorder.deny(host);
    const stats = recorder.stats();
    assert.deepEqual(stats.deniedHosts, [{ host: 'a.example.com', count: 2 }, { host: 'b.example.com', count: 1 }]);
    assert.equal(stats.omittedDeniedHosts, 2);
    assert.equal(stats.omittedDeniedAttempts, 3);
    assert.equal(stats.deniedConnections, 6);
});
