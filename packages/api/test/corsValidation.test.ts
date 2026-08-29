import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DESKTOP_RENDERER_ORIGIN } from '@propr/shared';
import cors from 'cors';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { corsRejectionHandler, createCorsOriginValidator } from '../corsValidation.js';

// Helper that runs the validator synchronously and reports whether the origin
// was allowed.
function isAllowed(validate: ReturnType<typeof createCorsOriginValidator>, origin: string | undefined): boolean {
  let allowed = false;
  validate(origin, (err, allow) => {
    allowed = !err && allow === true;
  });
  return allowed;
}

test('CORS allows the hosted UI origin under proxy mode', () => {
  // app.propr.dev is the hosted UI; cookies live on the per-instance proxy host,
  // so COOKIE_DOMAIN is intentionally unset.
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'https://app.propr.dev'), true);
});

test('CORS rejects unrelated origins under proxy mode', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'https://evil.example.com'), false);
  // A look-alike subdomain of the hosted UI is not the exact origin and must be
  // rejected when COOKIE_DOMAIN is unset.
  assert.equal(isAllowed(validate, 'https://app.propr.dev.evil.example.com'), false);
});

test('CORS allows requests with no origin', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, undefined), true);
});

test('CORS allows only the exact packaged desktop renderer custom origin', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, DESKTOP_RENDERER_ORIGIN), true);
  assert.equal(isAllowed(validate, `${DESKTOP_RENDERER_ORIGIN}.evil.example`), false);
  assert.equal(isAllowed(validate, 'propr-app://other-renderer'), false);
  assert.equal(isAllowed(validate, 'null'), false);
});

test('CORS allows HTTP(S) loopback origins for development', () => {
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'http://localhost:5173'), true);
  assert.equal(isAllowed(validate, 'http://127.0.0.1:5173'), true);
  assert.equal(isAllowed(validate, 'http://[::1]:5173'), true);
  assert.equal(isAllowed(validate, 'https://localhost:5173'), true);
  assert.equal(isAllowed(validate, 'https://[::1]:5173'), true);
});

test('CORS rejects unsafe schemes and non-loopback hosts', () => {
  // Only http/https loopback origins are trusted; an unusual scheme that still
  // parses with a loopback hostname must not be allowed.
  const validate = createCorsOriginValidator('https://app.propr.dev', undefined);

  assert.equal(isAllowed(validate, 'chrome-extension://localhost'), false);
  assert.equal(isAllowed(validate, 'file://localhost'), false);
  assert.equal(isAllowed(validate, 'file://[::1]/tmp/propr'), false);
  assert.equal(isAllowed(validate, 'http://[2001:db8::1]:5173'), false);
});

test('CORS allows COOKIE_DOMAIN subdomains for preview environments', () => {
  const validate = createCorsOriginValidator('https://app.example.com', '.example.com');

  assert.equal(isAllowed(validate, 'https://app.example.com'), true);
  assert.equal(isAllowed(validate, 'https://pr-1.example.com'), true);
  assert.equal(isAllowed(validate, 'https://example.com'), true);
  assert.equal(isAllowed(validate, 'https://other.example.org'), false);
});

test('CORS preserves http COOKIE_DOMAIN preview compatibility', () => {
  // Existing non-tunnel PR preview environments may reach the API over
  // http://<sub>.<cookie-domain>. Keep the legacy inline-validator behavior so
  // tunnel work does not introduce a silent unrelated breaking change.
  const validate = createCorsOriginValidator('https://app.example.com', '.example.com');

  assert.equal(isAllowed(validate, 'http://pr-1.example.com'), true);
  assert.equal(isAllowed(validate, 'http://example.com'), true);
});

test('CORS validator factory throws on an invalid FRONTEND_URL', () => {
  assert.throws(() => createCorsOriginValidator('not-a-url', undefined));
});

async function withCorsBoundary(
  runtimeMode: 'development' | 'production',
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.set('env', runtimeMode);
  app.use(cors({
    origin: createCorsOriginValidator('https://app.propr.dev', '.preview.example.com'),
    credentials: true,
  }));
  app.use(corsRejectionHandler);
  app.get('/api/compatibility', (_req, res) => res.json({ compatibility: 'public' }));
  app.all('/api/protected', (_req, res) => res.status(401).json({ error: 'Authentication required' }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

for (const runtimeMode of ['development', 'production'] as const) {
  test(`Express CORS boundary is sanitized in ${runtimeMode} mode`, async () => {
    await withCorsBoundary(runtimeMode, async baseUrl => {
      for (const origin of ['https://evil.example', 'null']) {
        const response = await fetch(`${baseUrl}/api/protected`, { headers: { Origin: origin } });
        assert.equal(response.status, 403);
        assert.equal(await response.text(), '{"error":"CORS origin rejected"}');
      }

      for (const origin of ['https://evil.example', 'null']) {
        const preflight = await fetch(`${baseUrl}/api/protected`, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
          },
        });
        assert.equal(preflight.status, 403);
        const rejectedBody = await preflight.text();
        assert.equal(rejectedBody, '{"error":"CORS origin rejected"}');
        assert.doesNotMatch(rejectedBody, /(?:Error|\bat\s|\/(?:app|home|usr|workspace)\/)/);
      }

      for (const origin of [
        'https://app.propr.dev',
        'https://pr-17.preview.example.com',
        'http://localhost:5173',
        'http://[::1]:5173',
      ]) {
        const response = await fetch(`${baseUrl}/api/protected`, { headers: { Origin: origin } });
        assert.equal(response.status, 401, `expected ${origin} to reach authentication`);
        assert.equal(response.headers.get('access-control-allow-origin'), origin);
      }

      const noOrigin = await fetch(`${baseUrl}/api/protected`);
      assert.equal(noOrigin.status, 401);

      const compatibility = await fetch(`${baseUrl}/api/compatibility`, {
        headers: { Origin: DESKTOP_RENDERER_ORIGIN },
      });
      assert.equal(compatibility.status, 200);
      assert.equal(compatibility.headers.get('access-control-allow-origin'), DESKTOP_RENDERER_ORIGIN);

      const allowedPreflight = await fetch(`${baseUrl}/api/protected`, {
        method: 'OPTIONS',
        headers: {
          Origin: DESKTOP_RENDERER_ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'X-ProPR-Desktop-Transport-Scope, Content-Type',
        },
      });
      assert.equal(allowedPreflight.status, 204);
      assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), DESKTOP_RENDERER_ORIGIN);
      assert.equal(
        allowedPreflight.headers.get('access-control-allow-headers'),
        'X-ProPR-Desktop-Transport-Scope, Content-Type',
      );
    });
  });
}

test('Socket.IO applies the shared CORS validator to the packaged desktop renderer', async () => {
  const server = createServer();
  const io = new SocketIOServer(server, {
    cors: {
      origin: createCorsOriginValidator('https://app.propr.dev', undefined),
      credentials: true,
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: DESKTOP_RENDERER_ORIGIN },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), DESKTOP_RENDERER_ORIGIN);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});
