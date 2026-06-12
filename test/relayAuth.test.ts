import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRelayAuth } from '../packages/core/src/auth/relayAuth.js';

interface RelayHandlerInfo {
  count: number;
  lastAuth?: string;
  lastPath?: string;
  lastBody?: string;
}

async function startRelay(
  respond: (info: RelayHandlerInfo, res: http.ServerResponse) => void,
): Promise<{ url: string; info: RelayHandlerInfo; close: () => Promise<void> }> {
  const info: RelayHandlerInfo = { count: 0 };
  const server = http.createServer((req, res) => {
    info.count += 1;
    info.lastAuth = req.headers.authorization;
    info.lastPath = req.url;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      info.lastBody = Buffer.concat(chunks).toString();
      respond(info, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    info,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jsonToken(token: string, ttlMs: number): (info: RelayHandlerInfo, res: http.ServerResponse) => void {
  return (_info, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token, expires_at: new Date(Date.now() + ttlMs).toISOString() }));
  };
}

test('relay auth fetches an installation token and sends the relay credential', async () => {
  const relay = await startRelay(jsonToken('ghs_relaytoken1', 3_600_000));
  try {
    const auth = createRelayAuth({ relayUrl: relay.url, relayToken: 'rly_secret', installationId: '42' });
    const result = await auth();
    assert.strictEqual(result.token, 'ghs_relaytoken1');
    assert.strictEqual(result.type, 'token');
    assert.strictEqual(result.tokenType, 'installation');
    assert.strictEqual(relay.info.lastAuth, 'Bearer rly_secret');
    assert.strictEqual(relay.info.lastPath, '/installation-token');
    assert.deepStrictEqual(JSON.parse(relay.info.lastBody ?? '{}'), { installation_id: '42' });
  } finally {
    await relay.close();
  }
});

test('relay auth caches the token until shortly before expiry', async () => {
  const relay = await startRelay(jsonToken('ghs_cached', 3_600_000));
  try {
    const auth = createRelayAuth({ relayUrl: relay.url, relayToken: 'rly_secret' });
    await auth();
    await auth();
    await auth();
    assert.strictEqual(relay.info.count, 1, 'should fetch once and reuse the cached token');
  } finally {
    await relay.close();
  }
});

test('relay auth re-fetches when the token is within the refresh margin', async () => {
  // 30s TTL is inside the 60s refresh margin, so every call must re-fetch.
  const relay = await startRelay(jsonToken('ghs_short', 30_000));
  try {
    const auth = createRelayAuth({ relayUrl: relay.url, relayToken: 'rly_secret' });
    await auth();
    await auth();
    assert.strictEqual(relay.info.count, 2, 'near-expiry token should be refreshed');
  } finally {
    await relay.close();
  }
});

test('relay auth throws a clear error when the relay rejects the credential', async () => {
  const relay = await startRelay((_info, res) => {
    res.statusCode = 401;
    res.end('unauthorized');
  });
  try {
    const auth = createRelayAuth({ relayUrl: relay.url, relayToken: 'bad' });
    await assert.rejects(() => auth(), /rejected the relay credential/i);
  } finally {
    await relay.close();
  }
});

test('relay auth hook sets the installation-token Authorization header', async () => {
  const relay = await startRelay(jsonToken('ghs_hooktoken', 3_600_000));
  try {
    const auth = createRelayAuth({ relayUrl: relay.url, relayToken: 'rly_secret' });
    let capturedHeaders: Record<string, string> | undefined;
    // Minimal fake of octokit's request interface: .endpoint.merge + callable.
    const fakeRequest = Object.assign(
      (endpoint: { headers: Record<string, string> }) => {
        capturedHeaders = endpoint.headers;
        return Promise.resolve({ status: 200, url: '', headers: {}, data: {} });
      },
      { endpoint: { merge: (route: string) => ({ method: 'GET', url: route, headers: {} as Record<string, string> }) } },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await auth.hook(fakeRequest as any, 'GET /rate_limit');
    assert.strictEqual(capturedHeaders?.authorization, 'token ghs_hooktoken');
  } finally {
    await relay.close();
  }
});

test('relay auth surfaces a network error when the relay is unreachable', async () => {
  // Port 1 is not listening; fetch should fail to connect.
  const auth = createRelayAuth({ relayUrl: 'http://127.0.0.1:1', relayToken: 'rly_secret' });
  await assert.rejects(() => auth(), /relay unreachable/i);
});

test('relay auth rejects unsupported auth types instead of silently returning an installation token', async () => {
  const relay = await startRelay(jsonToken('ghs_typetoken', 3_600_000));
  try {
    const auth = createRelayAuth({ relayUrl: relay.url, relayToken: 'rly_secret' });
    await assert.rejects(() => auth({ type: 'app' }), /only supports auth\({ type: "installation" }\)/);
    const result = await auth({ type: 'installation' });
    assert.strictEqual(result.token, 'ghs_typetoken');
  } finally {
    await relay.close();
  }
});
