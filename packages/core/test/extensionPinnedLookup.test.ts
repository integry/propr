import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { pinnedLookup } from '../src/extensions/endpointPolicy.js';
import { registryGet } from '../src/extensions/packageRegistry.js';

// The public registry is dialled by name with a custom `lookup` pinned to the
// vetted address. Node calls that lookup with `all: true` whenever it may race
// address families (the default for named hosts since Node 20), so these
// requests go through a real socket to a local server with both settings.

async function localRegistry(): Promise<{ port: number; requests: Array<{ url?: string; host?: string }>; close: () => Promise<void> }> {
  const requests: Array<{ url?: string; host?: string }> = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, host: request.headers.host });
    if (request.url === '/left-pad/1.3.0') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ name: 'left-pad', version: '1.3.0' }));
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"Not found"}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}

for (const autoSelectFamily of [true, false]) {
  test(`registryGet dials the public registry at its vetted address (lookup all: ${autoSelectFamily})`, async t => {
    const previous = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(autoSelectFamily);
    t.after(() => net.setDefaultAutoSelectFamily(previous));
    const registry = await localRegistry();
    t.after(registry.close);
    const vetted: string[] = [];
    // The name does not resolve, so a request can only arrive through the pinned lookup.
    const vet = async (endpoint: string) => { vetted.push(endpoint); return { address: '127.0.0.1', family: 4 }; };
    const base = `http://registry.propr-pinned.invalid:${registry.port}`;

    const found = await registryGet(`${base}/left-pad/1.3.0`, false, vet);
    assert.equal(found.status, 200);
    assert.deepEqual(JSON.parse(found.body.toString('utf8')), { name: 'left-pad', version: '1.3.0' });
    const missing = await registryGet(`${base}/propr-no-such-package/9.9.9`, false, vet);
    assert.equal(missing.status, 404);

    assert.deepEqual(vetted, [`${base}/left-pad/1.3.0`, `${base}/propr-no-such-package/9.9.9`]);
    assert.deepEqual(registry.requests.map(r => r.host), [`registry.propr-pinned.invalid:${registry.port}`, `registry.propr-pinned.invalid:${registry.port}`]);
  });
}

test('pinnedLookup answers only with the vetted address in both lookup shapes', () => {
  const lookup = pinnedLookup('203.0.113.7', 4);
  const results: unknown[] = [];
  lookup('attacker.example', { all: true }, (error, address, family) => results.push({ error, address, family }));
  lookup('attacker.example', {}, (error, address, family) => results.push({ error, address, family }));
  assert.deepEqual(results, [
    { error: null, address: [{ address: '203.0.113.7', family: 4 }], family: undefined },
    { error: null, address: '203.0.113.7', family: 4 },
  ]);
});
