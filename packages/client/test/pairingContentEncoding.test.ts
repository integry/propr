import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, it } from 'node:test';
import { ProprClientError } from '../src/index.js';
import { requestPairingProtocol } from '../src/pairingProtocol.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const jsonBytes = (byteLength: number): Buffer => {
  const prefix = '{"value":"';
  const suffix = '"}';
  const padding = byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(padding >= 0);
  const result = Buffer.from(`${prefix}${'A'.repeat(padding)}${suffix}`);
  assert.equal(result.byteLength, byteLength);
  return result;
};

type Encoding = 'identity' | 'gzip' | 'br';

const encode = (body: Buffer, encoding: Encoding): Buffer => {
  if (encoding === 'gzip') return gzipSync(body);
  if (encoding === 'br') return brotliCompressSync(body);
  return body;
};

const listen = async (
  fixtures: Record<string, { body: Buffer; encoding: Encoding }>,
): Promise<string> => {
  const server = createServer((request, response) => {
    const fixture = fixtures[request.url ?? ''];
    if (!fixture) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': fixture.encoding,
      'Content-Length': String(fixture.body.byteLength),
    });
    response.end(fixture.body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const request = (
  target: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<unknown> => requestPairingProtocol(fetchImplementation, target, { method: 'POST' });

const invalidResponse = (error: unknown): boolean =>
  error instanceof ProprClientError && error.kind === 'invalid_response';

describe('pairing response Content-Encoding', () => {
  it('accepts deterministic identity, gzip, and Brotli proxy responses at the decoded limit', async () => {
    const decoded = jsonBytes(4_096);
    const fixtures = Object.fromEntries(
      (['identity', 'gzip', 'br'] as const).map(encoding => {
        const body = encode(decoded, encoding);
        if (encoding !== 'identity') assert.notEqual(body.byteLength, decoded.byteLength);
        return [`/${encoding}`, { body, encoding }];
      }),
    );
    const origin = await listen(fixtures);
    const expected = JSON.parse(decoded.toString('utf8')) as unknown;

    for (const encoding of ['identity', 'gzip', 'br'] as const) {
      assert.deepEqual(await request(`${origin}/${encoding}`), expected);
    }
  });

  it('enforces the decoded 4 KiB cap for identity, gzip, and Brotli proxy responses', async () => {
    const decoded = jsonBytes(4_097);
    const fixtures = Object.fromEntries(
      (['identity', 'gzip', 'br'] as const).map(encoding => [
        `/${encoding}`,
        { body: encode(decoded, encoding), encoding },
      ]),
    );
    const origin = await listen(fixtures);

    for (const encoding of ['identity', 'gzip', 'br'] as const) {
      await assert.rejects(request(`${origin}/${encoding}`), invalidResponse);
    }
  });

  it('fails closed on truncated gzip and Brotli proxy responses without exposing decoder details', async () => {
    const decoded = jsonBytes(128);
    const gzip = encode(decoded, 'gzip');
    const br = encode(decoded, 'br');
    const origin = await listen({
      '/gzip': { body: gzip.subarray(0, Math.floor(gzip.byteLength / 2)), encoding: 'gzip' },
      '/br': { body: br.subarray(0, Math.floor(br.byteLength / 2)), encoding: 'br' },
    });

    for (const encoding of ['gzip', 'br'] as const) {
      await assert.rejects(request(`${origin}/${encoding}`), (error: unknown) =>
        error instanceof ProprClientError
        && ['invalid_response', 'network'].includes(error.kind)
        && !error.message.toLowerCase().includes('decompress'));
    }
  });

  it('rejects duplicate, stacked, empty, and unsupported Content-Encoding metadata', async () => {
    const body = jsonBytes(32);
    const values = ['', 'gzip, gzip', 'gzip, br', 'deflate'];

    for (const value of values) {
      await assert.rejects(request('https://propr.example.test/pair', async () => new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': value,
          'Content-Length': String(body.byteLength),
        },
      })), invalidResponse);
    }
  });

  it('validates encoded Content-Length syntax without comparing it to decoded bytes', async () => {
    const body = jsonBytes(32);
    const response = (length: string): Response => new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': length,
      },
    });

    assert.deepEqual(
      await request('https://propr.example.test/pair', async () => response('17')),
      JSON.parse(body.toString('utf8')),
    );
    for (const length of ['', '01', '-1', '17, 17', '9007199254740992']) {
      await assert.rejects(
        request('https://propr.example.test/pair', async () => response(length)),
        invalidResponse,
      );
    }
  });

  it('rejects an encoded Content-Length above the wire limit', async () => {
    const body = jsonBytes(32);

    await assert.rejects(request('https://propr.example.test/pair', async () => new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': '4097',
      },
    })), invalidResponse);
  });
});
