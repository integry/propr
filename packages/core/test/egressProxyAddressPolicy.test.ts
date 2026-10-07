import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { compileEgressAllowlist } from '../src/network/egressAllowlist.js';
import { isNonPublicAddress, startEgressProxy, type EgressLookup } from '../src/network/egressProxy.js';

// The proxy connects from the worker's network position, so an allowed name
// must not lead to the worker's loopback or private networks (Redis on the
// Compose network, say) unless an administrator listed that address.

const directories: string[] = [];
after(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

async function socketPath(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'egress-address-'));
    directories.push(directory);
    return path.join(directory, 'proxy.sock');
}

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

function plainRequest(proxySocket: string, url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ socketPath: proxySocket, path: url }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        outgoing.on('error', reject);
        outgoing.end();
    });
}

const resolvesTo = (...addresses: string[]): EgressLookup => async () => addresses.map(address => ({ address, family: net.isIP(address) }));

test('non-public ranges are recognised, including IPv4-mapped forms', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.18.0.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
        '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:ac12:2', 'not-an-address']) {
        assert.ok(isNonPublicAddress(address), address);
    }
    for (const address of ['140.82.112.3', '203.0.113.10', '2606:4700::1111', '::ffff:140.82.112.3']) assert.ok(!isNonPublicAddress(address), address);
});

test('an allowed name that resolves to loopback or a private address is refused without any upstream connection', async () => {
    const connected: string[] = [];
    let answer = resolvesTo('127.0.0.1');
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist(['evil.example.com:6379', 'evil.example.com']),
        connect: (port, host) => { connected.push(`${host}:${port}`); return net.connect({ port, host: '127.0.0.1' }); },
        lookup: host => answer(host),
    });
    try {
        for (const addresses of [['127.0.0.1'], ['172.18.0.2'], ['::ffff:127.0.0.1'], ['fe80::1'], ['fd12::3'], ['169.254.169.254'], ['203.0.113.10', '10.0.0.5']]) {
            answer = resolvesTo(...addresses);
            const tunnel = await connectThrough(proxy.socketPath, 'evil.example.com:6379');
            assert.equal(tunnel.status, 'HTTP/1.1 403 Forbidden', addresses.join(','));
            assert.match(tunnel.rest, /non-public address/);
            assert.doesNotMatch(tunnel.rest, /\d+\.\d+\.\d+\.\d+|::/, 'the resolved address is not disclosed to the container');
            tunnel.socket.destroy();
        }
        answer = resolvesTo('127.0.0.1');
        const plain = await plainRequest(proxy.socketPath, 'http://evil.example.com/flush');
        assert.equal(plain.status, 403, 'plain HTTP is held to the same rule');
        assert.deepEqual(connected, [], 'no connection is opened from the worker');
        const stats = proxy.stats();
        assert.equal(stats.allowedConnections, 0);
        assert.equal(stats.deniedConnections, 8);
        assert.deepEqual(stats.deniedHosts, [{ host: 'evil.example.com:6379', count: 7 }, { host: 'evil.example.com', count: 1 }]);
    } finally {
        await proxy.close();
    }
});

test('only an administrator IP-literal entry opens a non-public address; a repository entry does not', async () => {
    const upstream = net.createServer(socket => socket.on('data', () => socket.write('pong')));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as net.AddressInfo).port;
    const connected: string[] = [];
    const start = async (instanceEntries: string[]) => startEgressProxy({
        socketPath: await socketPath(),
        // The run's full list: instance and repository entries together.
        allowlist: compileEgressAllowlist([`cache.internal.example.com:${port}`, `127.0.0.1:${port}`]),
        addressAllowlist: compileEgressAllowlist(instanceEntries),
        connect: (targetPort, host) => { connected.push(`${host}:${targetPort}`); return net.connect({ port: targetPort, host: '127.0.0.1' }); },
        lookup: resolvesTo('127.0.0.1'),
    });
    const repositoryOnly = await start([]);
    const administrator = await start([`127.0.0.1:${port}`]);
    try {
        for (const authority of [`127.0.0.1:${port}`, `cache.internal.example.com:${port}`]) {
            const refused = await connectThrough(repositoryOnly.socketPath, authority);
            assert.equal(refused.status, 'HTTP/1.1 403 Forbidden', `${authority} needs the administrator's address entry`);
            refused.socket.destroy();
        }
        assert.deepEqual(connected, []);

        const named = await connectThrough(administrator.socketPath, `cache.internal.example.com:${port}`);
        assert.equal(named.status, 'HTTP/1.1 200 Connection Established');
        named.socket.destroy();
        const literal = await connectThrough(administrator.socketPath, `127.0.0.1:${port}`);
        assert.equal(literal.status, 'HTTP/1.1 200 Connection Established');
        literal.socket.destroy();
        assert.deepEqual(connected, [`127.0.0.1:${port}`, `127.0.0.1:${port}`], 'the name is connected at the vetted address');
        assert.equal(administrator.stats().allowedConnections, 2);
    } finally {
        await repositoryOnly.close();
        await administrator.close();
        await new Promise(resolve => upstream.close(resolve));
    }
});

test('the same check applies before chaining through the worker proxy; a name the worker cannot resolve is left to that proxy', async () => {
    const seen: string[] = [];
    const workerProxy = http.createServer();
    workerProxy.on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
        seen.push(request.url ?? '');
        socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    await new Promise<void>(resolve => workerProxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = new URL(`http://127.0.0.1:${(workerProxy.address() as net.AddressInfo).port}`);
    let answer: EgressLookup = resolvesTo('10.0.0.8');
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist(['internal.example.com', 'external.example.com']),
        lookup: host => answer(host),
        upstreamProxies: { https: proxyUrl, noProxy: [] },
    });
    try {
        const refused = await connectThrough(proxy.socketPath, 'internal.example.com:443');
        assert.equal(refused.status, 'HTTP/1.1 403 Forbidden');
        refused.socket.destroy();
        assert.deepEqual(seen, [], 'the worker proxy is never asked for a name that resolves to a private address');

        answer = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
        const chained = await connectThrough(proxy.socketPath, 'external.example.com:443');
        assert.equal(chained.status, 'HTTP/1.1 200 Connection Established');
        chained.socket.destroy();
        assert.deepEqual(seen, ['external.example.com:443'], 'the name, not an address, goes to the worker proxy');
    } finally {
        await proxy.close();
        workerProxy.closeAllConnections();
        await new Promise(resolve => workerProxy.close(resolve));
    }
});

test('a name that does not resolve, without a worker proxy, is a failed connection', async () => {
    const proxy = await startEgressProxy({
        socketPath: await socketPath(),
        allowlist: compileEgressAllowlist(['gone.example.com']),
        connect: () => assert.fail('nothing to connect to'),
        lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    try {
        const tunnel = await connectThrough(proxy.socketPath, 'gone.example.com:443');
        assert.equal(tunnel.status, 'HTTP/1.1 502 Bad Gateway');
        tunnel.socket.destroy();
        assert.deepEqual(proxy.stats().failedHosts, [{ host: 'gone.example.com', count: 1 }]);
    } finally {
        await proxy.close();
    }
});

test('connecting and the worker proxy handshake are bounded; an established tunnel is not', async () => {
    // A worker proxy that accepts TCP but never answers CONNECT.
    const held = new Set<net.Socket>();
    const silent = net.createServer(socket => { held.add(socket); socket.on('error', () => undefined); });
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    const silentUrl = new URL(`http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`);
    const echo = net.createServer(socket => socket.on('data', chunk => socket.write(`echo:${chunk}`)));
    await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve));
    const echoPort = (echo.address() as net.AddressInfo).port;
    const handshakeTimeoutMs = 150;
    const chained = await startEgressProxy({
        socketPath: await socketPath(), allowlist: compileEgressAllowlist(['api.example.com']), lookup: resolvesTo('203.0.113.10'),
        upstreamProxies: { https: silentUrl, noProxy: [] }, handshakeTimeoutMs,
    });
    // An upstream whose TCP connect never completes (a black-holed address): writes are buffered, 'connect' never comes.
    const unconnected = await startEgressProxy({
        socketPath: await socketPath(), allowlist: compileEgressAllowlist(['slow.example.com']), lookup: resolvesTo('203.0.113.10'),
        connect: () => new Duplex({ read() { /* never */ }, write(_chunk, _encoding, callback) { callback(); } }) as net.Socket, handshakeTimeoutMs,
    });
    const direct = await startEgressProxy({
        socketPath: await socketPath(), allowlist: compileEgressAllowlist([`stream.example.com:${echoPort}`]), lookup: resolvesTo('203.0.113.10'),
        connect: port => net.connect({ port, host: '127.0.0.1' }), handshakeTimeoutMs,
    });
    try {
        const started = Date.now();
        const waiting = await connectThrough(chained.socketPath, 'api.example.com:443');
        assert.equal(waiting.status, 'HTTP/1.1 504 Gateway Timeout');
        assert.ok(Date.now() - started < 5_000);
        waiting.socket.destroy();
        assert.deepEqual(chained.stats().failedHosts, [{ host: 'api.example.com', count: 1 }]);

        const tunnel = await connectThrough(unconnected.socketPath, 'slow.example.com:443');
        assert.equal(tunnel.status, 'HTTP/1.1 504 Gateway Timeout');
        tunnel.socket.destroy();
        const plain = await plainRequest(unconnected.socketPath, 'http://slow.example.com/');
        assert.equal(plain.status, 504);
        assert.equal(unconnected.stats().failedConnections, 2);

        const open = await connectThrough(direct.socketPath, `stream.example.com:${echoPort}`);
        assert.equal(open.status, 'HTTP/1.1 200 Connection Established');
        await new Promise(resolve => setTimeout(resolve, handshakeTimeoutMs * 3));
        const reply = new Promise<string>(resolve => open.socket.once('data', chunk => resolve(chunk.toString())));
        open.socket.write('still-here');
        assert.equal(await reply, 'echo:still-here', 'a quiet established tunnel outlives the handshake deadline');
        open.socket.destroy();
        assert.equal(direct.stats().failedConnections, 0);
    } finally {
        await chained.close();
        await unconnected.close();
        await direct.close();
        for (const socket of held) socket.destroy();
        await new Promise(resolve => silent.close(resolve));
        await new Promise(resolve => echo.close(resolve));
    }
});
