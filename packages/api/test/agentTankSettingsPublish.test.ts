import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import type { Request, Response } from 'express';
import * as core from '@propr/core';

const savedSettings: unknown[] = [];
const published: Array<{ eventType: string }> = [];

await mock.module('@propr/core', {
  namedExports: {
    ...core,
    saveAgentTankSettings: async (settings: unknown) => { savedSettings.push(settings); },
    getEventPublisher: () => ({
      publishUsageUpdate: async () => {
        published.push({ eventType: 'usage:update' });
        return true;
      },
    }),
  },
});

const { createAgentTankRoutes } = await import('../routes/configRoutesAgentTank.js');

after(async () => core.closeConnection());

function responseRecorder(): { response: Response; body: () => unknown } {
  let body: unknown;
  const response = {
    json(payload: unknown) { body = payload; return response; },
    status() { return response; },
  } as unknown as Response;
  return { response, body: () => body };
}

describe('agent tank settings publishing', { concurrency: false }, () => {
  beforeEach(() => {
    savedSettings.length = 0;
    published.length = 0;
  });

  test('tells open sidebars that the integration was enabled', async () => {
    const { response, body } = responseRecorder();

    await createAgentTankRoutes().postAgentTankSettings(
      { body: { enabled: true, url: 'http://agent-tank.test' } } as Request,
      response,
    );

    assert.deepEqual(body(), { success: true });
    assert.deepEqual(savedSettings, [{ enabled: true, url: 'http://agent-tank.test' }]);
    assert.deepEqual(published.map(payload => payload.eventType), ['usage:update']);
  });

  test('tells them about a disable too, so the widget can leave', async () => {
    const { response } = responseRecorder();

    await createAgentTankRoutes().postAgentTankSettings(
      { body: { enabled: false, url: 'http://agent-tank.test' } } as Request,
      response,
    );

    assert.deepEqual(published.map(payload => payload.eventType), ['usage:update']);
  });
});
