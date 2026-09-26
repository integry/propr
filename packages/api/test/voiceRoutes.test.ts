import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Request, Response } from 'express';
import type { VoiceBriefingResponse, VoiceBriefingScope } from '@propr/shared';
import {
  createVoiceRoutes,
  type VoiceBriefingReader,
} from '../routes/voiceRoutes.js';

const NOW = '2026-09-07T04:30:00.000Z';

function briefing(scope: VoiceBriefingScope): VoiceBriefingResponse {
  return {
    generatedAt: NOW,
    scope,
    headline: `Briefing for ${scope}.`,
    speechText: `Briefing for ${scope}.`,
    counts: { running: 0, queued: 0, attention: 0, plans: 0, total: 0 },
    items: [],
  };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return {
    user: { id: 'session-user' },
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

function recorder(): {
  response: Response;
  status: () => number;
  body: () => unknown;
} {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    },
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => payload };
}

function reader(
  getBriefing: VoiceBriefingReader['getBriefing'] = async (_userId, scope = 'all') =>
    briefing(scope),
): VoiceBriefingReader {
  return { getBriefing };
}

describe('voice routes', () => {
  test('returns the fixed browser-audio capability contract without sensitive fields', () => {
    const routes = createVoiceRoutes({ briefingService: reader() });
    const result = recorder();

    routes.getCapabilities(request(), result.response);

    assert.equal(result.status(), 200);
    assert.deepEqual(result.body(), {
      mode: 'on_demand',
      serverAudio: false,
      persistentSession: false,
      rawAudioAccepted: false,
      transcriptStored: false,
    });
  });

  test('uses only the authenticated user for every supported scope', async () => {
    const calls: Array<[string, VoiceBriefingScope | undefined]> = [];
    const routes = createVoiceRoutes({
      briefingService: reader(async (userId, scope) => {
        calls.push([userId, scope]);
        return briefing(scope ?? 'all');
      }),
    });

    for (const scope of ['all', 'running', 'attention'] as const) {
      const result = recorder();
      await routes.getBriefing(request({
        query: { scope, userId: 'query-user' },
        body: { userId: 'body-user' },
      }), result.response);

      assert.equal(result.status(), 200);
      assert.equal((result.body() as VoiceBriefingResponse).scope, scope);
    }

    assert.deepEqual(calls, [
      ['session-user', 'all'],
      ['session-user', 'running'],
      ['session-user', 'attention'],
    ]);
  });

  test('defaults an omitted scope to all', async () => {
    let receivedScope: VoiceBriefingScope | undefined;
    const routes = createVoiceRoutes({
      briefingService: reader(async (_userId, scope) => {
        receivedScope = scope;
        return briefing(scope ?? 'all');
      }),
    });
    const result = recorder();

    await routes.getBriefing(request(), result.response);

    assert.equal(result.status(), 200);
    assert.equal(receivedScope, 'all');
  });

  test('rejects invalid and repeated scope parameters before reading data', async () => {
    let calls = 0;
    const routes = createVoiceRoutes({
      briefingService: reader(async () => {
        calls += 1;
        return briefing('all');
      }),
    });

    for (const scope of ['queued', '', ['all', 'running']]) {
      const result = recorder();
      await routes.getBriefing(request({ query: { scope } }), result.response);

      assert.equal(result.status(), 400);
      assert.deepEqual(result.body(), { error: 'Invalid voice briefing scope' });
    }
    assert.equal(calls, 0);
  });

  test('requires an authenticated identity when a handler is called directly', async () => {
    const routes = createVoiceRoutes({ briefingService: reader() });

    for (const handler of [routes.getCapabilities, routes.getBriefing]) {
      const result = recorder();
      await handler(request({ user: undefined }), result.response);
      assert.equal(result.status(), 401);
      assert.deepEqual(result.body(), { error: 'Authentication required' });
    }
  });

  test('runtime-validates service output and keeps failures and logs non-sensitive', async () => {
    const logs: string[] = [];
    const routes = createVoiceRoutes({
      briefingService: reader(async () => ({
        ...briefing('all'),
        privatePrompt: 'SECRET RESPONSE CONTENT',
      } as VoiceBriefingResponse)),
      logError: message => logs.push(message),
    });
    const result = recorder();

    await routes.getBriefing(request(), result.response);

    assert.equal(result.status(), 500);
    assert.deepEqual(result.body(), { error: 'Internal server error' });
    assert.deepEqual(logs, ['Failed to build voice briefing']);
    assert.equal(JSON.stringify({ body: result.body(), logs }).includes('SECRET'), false);
  });

  test('does not expose provider errors in the response or logs', async () => {
    const logs: string[] = [];
    const routes = createVoiceRoutes({
      briefingService: reader(async () => {
        throw new Error('SECRET DATABASE BINDING');
      }),
      logError: message => logs.push(message),
    });
    const result = recorder();

    await routes.getBriefing(request(), result.response);

    assert.equal(result.status(), 500);
    assert.deepEqual(result.body(), { error: 'Internal server error' });
    assert.deepEqual(logs, ['Failed to build voice briefing']);
  });
});
