import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net, { type AddressInfo } from 'node:net';
import https from 'node:https';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { ExtensionConnectError, connectHappyEyeballs, interleaveAddressFamilies, type ExtensionDialAddress } from '../src/extensions/happyEyeballs.js';
import { extensionRequestFailureReason, requestExtensionMcp, type ExtensionMcpExchange } from '../src/extensions/endpointPolicy.js';
import { OAuthNetworkError, createOAuthHttpsTransport, oauthRequest } from '../src/extensions/extensionOAuthHttp.js';

// The *.sprites.app shape that hung Fly Machines runs: an AAAA answer first, then an A answer. The IPv6 path is
// black-holed (a SYN that is never answered); the IPv4 path works.
const IPV6 = { address: '2606:4700:4700::1111', family: 6 };
const IPV4 = { address: '8.8.8.8', family: 4 };
const HOST = 'mcp.synthetic.example';

async function tlsFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-happy-eyeballs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'ignore' });
  const cert = await fs.readFile(path.join(root, 'cert.pem'));
  let connections = 0;
  const server = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const rpc = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown } : {};
    // Every response closes its connection, so each request of a session needs a new one.
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: { ok: true } }));
  });
  server.on('secureConnection', () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  // Trust the fixture's certificate; the request keeps its vetted destination and TLS identity.
  const original = https.request;
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, callback: Parameters<typeof https.request>[2]) => original(url, { ...options, ca: cert }, callback));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

/**
 * Map dials: the black-holed addresses get a socket that never connects, a refused one a closed local port, anything
 * else the local fixture. Records every dialled address in order.
 */
async function dialPlan(t: TestContext, plan: { port?: number; blackholed?: string[]; refused?: string[] }) {
  const closed = net.createServer(); await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = (closed.address() as AddressInfo).port; await new Promise<void>(resolve => closed.close(() => resolve()));
  const dialed: string[] = []; const stalled: net.Socket[] = [];
  const connect = net.connect;
  t.mock.method(net, 'connect', (options: net.TcpNetConnectOpts) => {
    dialed.push(String(options.host));
    if (plan.blackholed?.includes(String(options.host))) { const socket = new net.Socket(); stalled.push(socket); return socket; }
    if (plan.refused?.includes(String(options.host))) return connect({ host: '127.0.0.1', port: closedPort });
    return connect({ host: '127.0.0.1', port: plan.port ?? options.port });
  });
  return { dialed, stalled };
}

test('Happy Eyeballs orders addresses by alternating families from the first answer', () => {
  const a = (address: string, family: number): ExtensionDialAddress => ({ address, family });
  assert.deepEqual(interleaveAddressFamilies([a('v6a', 6), a('v6b', 6), a('v4a', 4), a('v4b', 4), a('v4c', 4)]).map(entry => entry.address), ['v6a', 'v4a', 'v6b', 'v4b', 'v4c']);
  assert.deepEqual(interleaveAddressFamilies([a('v4a', 4), a('v6a', 6)]).map(entry => entry.address), ['v4a', 'v6a']);
  assert.deepEqual(interleaveAddressFamilies([]), []);
});

test('a black-holed IPv6 address falls back to IPv4 after the attempt delay, not the request timeout', async t => {
  const fixture = net.createServer(socket => socket.end()); await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const plan = await dialPlan(t, { port: (fixture.address() as AddressInfo).port, blackholed: [IPV6.address] });
  const started = Date.now();
  const { socket, address } = await new Promise<{ socket: net.Socket; address: ExtensionDialAddress }>((resolve, reject) =>
    connectHappyEyeballs([IPV6, IPV4], { budgetMs: 10_000 }, (error, connected, winner) => error ? reject(error) : resolve({ socket: connected!, address: winner! })));
  const elapsed = Date.now() - started;
  socket.destroy();
  assert.deepEqual(address, IPV4);
  assert.deepEqual(plan.dialed, [IPV6.address, IPV4.address]);
  assert.ok(elapsed >= 200 && elapsed < 2_000, `IPv4 started about 250 ms after IPv6, connected in ${elapsed} ms`);
  assert.ok(plan.stalled.every(stalled => stalled.destroyed), 'the losing attempt is closed');
});

test('when no address connects, the reason names each family, address and outcome in order', async t => {
  const plan = await dialPlan(t, { blackholed: [IPV6.address, IPV4.address] });
  const failure = (addresses: ExtensionDialAddress[], options: { budgetMs: number; attemptTimeoutMs?: number }) => new Promise<ExtensionConnectError>((resolve, reject) =>
    connectHappyEyeballs(addresses, { delayMs: 20, ...options }, error => error ? resolve(error) : reject(new Error('connected'))));
  assert.equal((await failure([IPV6, IPV4], { budgetMs: 5_000, attemptTimeoutMs: 100 })).reason, `connect timeout (IPv6 ${IPV6.address}, then IPv4 ${IPV4.address})`);
  // The overall budget ends attempts still running; addresses never started are counted.
  const third = { address: '1.1.1.1', family: 4 };
  plan.dialed.length = 0;
  const budget = await failure([IPV6, IPV4, third], { budgetMs: 30, attemptTimeoutMs: 1_000 });
  assert.match(budget.reason, /^connect timeout \(IPv6 2606:4700:4700::1111, then IPv4 8\.8\.8\.8; 1 more not tried\)$|^connect timeout \(IPv6 2606:4700:4700::1111; 2 more not tried\)$/);
  assert.equal(extensionRequestFailureReason(budget), budget.reason);
  assert.ok(plan.stalled.every(stalled => stalled.destroyed));
});

test('a refused address is reported with its error code and the next family is tried at once', async t => {
  const plan = await dialPlan(t, { refused: [IPV6.address], blackholed: [IPV4.address] });
  const error = await new Promise<ExtensionConnectError>((resolve, reject) =>
    connectHappyEyeballs([IPV6, IPV4], { budgetMs: 5_000, delayMs: 2_000, attemptTimeoutMs: 100 }, failed => failed ? resolve(failed) : reject(new Error('connected'))));
  assert.equal(error.reason, `connect failed (IPv6 ${IPV6.address} ECONNREFUSED, then IPv4 ${IPV4.address} timed out)`);
  assert.deepEqual(plan.dialed, [IPV6.address, IPV4.address]);
});

test('an MCP request to an endpoint with a black-holed IPv6 path connects over IPv4 within the budget', async t => {
  const fixture = await tlsFixture(t);
  const plan = await dialPlan(t, { port: fixture.port, blackholed: [IPV6.address] });
  const lookups: string[] = [];
  t.mock.method(dns, 'lookup', async (host: string) => { lookups.push(host); return [IPV6, IPV4]; });
  const started = Date.now();
  const reply = await requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 7, result: { ok: true } });
  assert.ok(Date.now() - started < 3_000, 'well inside the 10 s request timeout');
  assert.deepEqual(plan.dialed, [IPV6.address, IPV4.address]);
  assert.deepEqual(lookups, [HOST]);
});

test('every resolved address is vetted before any is dialled', async t => {
  const plan = await dialPlan(t, {});
  t.mock.method(dns, 'lookup', async () => [IPV6, { address: '10.0.0.1', family: 4 }]);
  await assert.rejects(requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /public/);
  t.mock.method(dns, 'lookup', async () => [{ address: 'fd00::1', family: 6 }, IPV4]);
  await assert.rejects(requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /public/);
  assert.deepEqual(plan.dialed, []);
});

test('a session keeps dialling the address that connected, even when DNS answers change', async t => {
  const fixture = await tlsFixture(t);
  const plan = await dialPlan(t, { port: fixture.port, blackholed: [IPV6.address] });
  let answers = [IPV6, IPV4];
  t.mock.method(dns, 'lookup', async () => answers);
  const exchange: ExtensionMcpExchange = { pin: true };
  t.after(() => exchange.connection?.agent.destroy());
  await requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize' }, undefined, {}, exchange);
  assert.deepEqual(exchange.connection?.connected, IPV4);
  assert.deepEqual(plan.dialed, [IPV6.address, IPV4.address]);
  // The upstream closed the connection; the session's next one goes straight to the address that answered.
  answers = [IPV6, IPV4, { address: '1.1.1.1', family: 4 }];
  await requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, undefined, {}, exchange);
  assert.deepEqual(plan.dialed, [IPV6.address, IPV4.address, IPV4.address]);
  assert.equal(fixture.connections(), 2);
  // The policy check still runs on every request of the session.
  answers = [IPV4, { address: '10.0.0.1', family: 4 }];
  await assert.rejects(requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, undefined, {}, exchange), /public/);
  assert.equal(plan.dialed.length, 3);
});

test('a failed MCP connect reports the families tried as the request reason', async t => {
  await dialPlan(t, { blackholed: [IPV6.address], refused: [IPV4.address] });
  t.mock.method(dns, 'lookup', async () => [IPV6, IPV4]);
  const error = await requestExtensionMcp(`https://${HOST}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).then(() => undefined, (failed: unknown) => failed);
  assert.equal(extensionRequestFailureReason(error), `connect failed (IPv6 ${IPV6.address} timed out, then IPv4 ${IPV4.address} ECONNREFUSED)`);
});

test('OAuth requests fall back from a black-holed IPv6 path and report the families tried when none connects', async t => {
  const fixture = await tlsFixture(t);
  const plan = await dialPlan(t, { port: fixture.port, blackholed: [IPV6.address] });
  const transport = createOAuthHttpsTransport({ lookup: async () => [IPV6, IPV4] });
  const started = Date.now();
  const response = await oauthRequest(transport, { method: 'GET', url: `https://${HOST}/.well-known/oauth-authorization-server` });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 3_000);
  assert.deepEqual(plan.dialed, [IPV6.address, IPV4.address]);
  // Both paths down: the error keeps its fixed message and carries the connect reason.
  const down = createOAuthHttpsTransport({ lookup: async () => [IPV6, { address: '1.1.1.1', family: 4 }] });
  plan.dialed.length = 0;
  t.mock.method(net, 'connect', (options: net.TcpNetConnectOpts) => { plan.dialed.push(String(options.host)); return new net.Socket(); });
  const error = await oauthRequest(down, { method: 'POST', url: `https://${HOST}/token`, body: 'grant_type=refresh_token' }).then(() => undefined, (failed: unknown) => failed);
  assert.ok(error instanceof OAuthNetworkError);
  assert.equal(error.message, 'OAuth request failed');
  assert.equal(error.reason, `connect timeout (IPv6 ${IPV6.address}, then IPv4 1.1.1.1)`);
  assert.deepEqual(plan.dialed, [IPV6.address, '1.1.1.1']);
});
