import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROPR_API_COMPATIBILITY } from '@propr/shared';
import {
  classifyApiBaseUrl,
  ProprClient,
  ProprClientError,
  normalizeApiBaseUrl,
  normalizeInstanceProfile,
} from '../src/index.js';

describe('Propr API base URLs and instance profiles', () => {
  it('supports browser same-origin, loopback, and secure remote instances', () => {
    assert.equal(normalizeApiBaseUrl(), '');
    assert.equal(normalizeApiBaseUrl('  http://localhost:4000///  '), 'http://localhost:4000');
    assert.equal(normalizeApiBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    assert.equal(normalizeApiBaseUrl('http://[::1]:3000'), 'http://[::1]:3000');
    assert.equal(normalizeApiBaseUrl('https://propr.example.com/'), 'https://propr.example.com');

    const profile = normalizeInstanceProfile({
      id: 'remote-primary',
      name: 'Remote primary',
      apiBaseUrl: 'https://propr.example.com/',
      authentication: 'bearer',
    });
    assert.equal(profile.apiBaseUrl, 'https://propr.example.com');
    assert.equal(profile.name, 'Remote primary');
  });

  it('rejects malformed and unsafe endpoints', () => {
    for (const value of [
      '/api',
      'ftp://propr.example.com',
      'https://user:secret@propr.example.com',
      'https://propr.example.com/api',
      'https://propr.example.com?token=secret',
      'http://propr.example.com',
      'https://t-instance123.propr.dev:443',
      'https://t-instance123.propr.dev:8443',
      'https://t-%69nstance123.propr.dev',
      'https://t-instance123.propr%2edev',
    ]) {
      assert.throws(() => normalizeApiBaseUrl(value), ProprClientError);
    }
  });

  it('classifies only the canonical hosted ProPR Connect origin as verified', () => {
    assert.deepEqual(classifyApiBaseUrl(' https://T-instance-123.propr.dev/ '), {
      baseUrl: 'https://t-instance-123.propr.dev',
      kind: 'propr-connect',
      connectInstanceId: 'instance-123',
    });
    assert.equal(classifyApiBaseUrl('http://127.0.0.1:4000').kind, 'loopback');
    assert.equal(classifyApiBaseUrl('https://propr.example.com').kind, 'remote');

    for (const rejectedReserved of [
      'https://t-instance-123.foo.propr.dev',
      'https://t-\u0430bc.propr.dev',
    ]) {
      assert.throws(() => classifyApiBaseUrl(rejectedReserved), (error: unknown) =>
        error instanceof ProprClientError
        && error.code === 'INVALID_API_BASE_URL'
        && !error.message.includes(rejectedReserved));
    }

    for (const lookalike of [
      'https://t-instance-123.propr.dev.example.com',
      'https://t-abc.pr\u03bfpr.dev',
    ]) {
      assert.notEqual(classifyApiBaseUrl(lookalike).kind, 'propr-connect', lookalike);
    }
  });

  it('bounds malformed configuration and reports only a fixed safe code and message', () => {
    const unsafeValues = [
      'https://user:password-sentinel@t-instance123.propr.dev',
      'https://t-instance123.propr.dev?token=query-token-sentinel',
      `https://example.com/${'private-path-sentinel'.repeat(200)}`,
    ];
    for (const value of unsafeValues) {
      assert.throws(() => normalizeApiBaseUrl(value), (error: unknown) => {
        assert.ok(error instanceof ProprClientError);
        assert.equal(error.code, 'INVALID_API_BASE_URL');
        assert.equal(error.message, 'The configured ProPR API URL is invalid.');
        assert.doesNotMatch(JSON.stringify(error), /password-sentinel|query-token-sentinel|private-path-sentinel/);
        return true;
      });
    }
  });
});

describe('ProprClient REST transport', () => {
  it('routes Connect status and REST calls directly to the verified origin', async () => {
    const calls: string[] = [];
    const client = new ProprClient({
      baseUrl: 'https://t-instance123.propr.dev',
      authentication: { type: 'none' },
      fetch: async input => {
        calls.push(input.toString());
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await client.request('/api/status');
    await client.request('/api/tasks');
    assert.deepEqual(calls, [
      'https://t-instance123.propr.dev/api/status',
      'https://t-instance123.propr.dev/api/tasks',
    ]);
  });

  it('adds a fresh bearer token without exposing it in the endpoint', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const client = new ProprClient({
      baseUrl: 'https://propr.example.com',
      authentication: { type: 'bearer', getAccessToken: () => 'secret-token' },
      fetch: async (input, init) => {
        calls.push([input, init]);
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await client.request('/api/status');

    assert.equal(calls[0][0], 'https://propr.example.com/api/status');
    assert.equal(new Headers(calls[0][1]?.headers).get('Authorization'), 'Bearer secret-token');
    assert.doesNotMatch(String(calls[0][0]), /secret-token/);
  });

  it('uses cookies for session authentication', async () => {
    let captured: RequestInit | undefined;
    const client = new ProprClient({
      authentication: { type: 'session' },
      fetch: async (_input, init) => {
        captured = init;
        return new Response(null, { status: 204 });
      },
    });

    await client.request('/api/status');
    assert.equal(captured?.credentials, 'include');
  });

  it('returns structured HTTP errors without changing the backend body', async () => {
    const body = { code: 'NOT_ALLOWED', message: 'No access' };
    const client = new ProprClient({
      fetch: async () => new Response(JSON.stringify(body), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    await assert.rejects(client.request('/api/admin'), (error: unknown) => {
      assert.ok(error instanceof ProprClientError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 403);
      assert.equal(error.code, 'NOT_ALLOWED');
      assert.deepEqual(error.body, body);
      return true;
    });
  });

  it('distinguishes cancellation from a client timeout', async () => {
    const abortingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      const rejectAborted = () => reject(new DOMException('Aborted', 'AbortError'));
      if (init?.signal?.aborted) rejectAborted();
      else init?.signal?.addEventListener('abort', rejectAborted);
    });
    const client = new ProprClient({ fetch: abortingFetch });

    await assert.rejects(
      client.fetch('/api/slow', {}, { timeoutMs: 1 }),
      (error: unknown) => error instanceof ProprClientError && error.kind === 'timeout'
    );

    const controller = new AbortController();
    const cancelled = client.fetch('/api/slow', { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      cancelled,
      (error: unknown) => error instanceof ProprClientError && error.kind === 'aborted'
    );
  });
});

describe('Propr compatibility negotiation', () => {
  it('reports an API compatibility mismatch', async () => {
    const client = new ProprClient({
      fetch: async () => new Response(JSON.stringify({
        version: '99.0.0',
        apiCompatibility: '9999-12-31',
        uiCompatibility: PROPR_API_COMPATIBILITY,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    const result = await client.negotiateCompatibility();
    assert.equal(result.compatible, false);
    if (!result.compatible) assert.equal(result.reason, 'too_new');
    await assert.rejects(
      client.requireCompatibility(),
      (error: unknown) => error instanceof ProprClientError
        && error.kind === 'compatibility'
        && error.code === 'too_new'
    );
  });

  it('rejects malformed compatibility metadata as a structured response error', async () => {
    const client = new ProprClient({
      fetch: async () => new Response(JSON.stringify({ apiCompatibility: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    await assert.rejects(
      client.negotiateCompatibility(),
      (error: unknown) => error instanceof ProprClientError && error.kind === 'invalid_response'
    );
  });
});
