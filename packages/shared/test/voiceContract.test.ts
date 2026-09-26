import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  VOICE_BRIEFING_ACTIONS,
  VOICE_BRIEFING_ITEM_KINDS,
  VOICE_BRIEFING_MAX_ITEMS,
  VOICE_BRIEFING_SCOPES,
  parseVoiceBriefingItem,
  parseVoiceBriefingScope,
  voiceBriefingResponseSchema,
  voiceCapabilitiesResponseSchema,
} from '../src/index.ts';

const NOW = '2026-09-07T02:30:00.000Z';

function item(
  position = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    reference: `task ${position}`,
    position,
    kind: 'task',
    id: `task-${position}`,
    title: `Synthetic task ${position}`,
    repository: 'integry/propr',
    status: 'running',
    summary: `Synthetic task ${position} in integry/propr is running.`,
    href: `/tasks/task-${position}`,
    requiresAttention: false,
    actions: ['open', 'stop'],
    updatedAt: NOW,
    ...overrides,
  };
}

function response(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    generatedAt: NOW,
    scope: 'all',
    headline: '1 running, 0 queued, 0 plans, and 0 needing attention.',
    speechText: 'One task is running.',
    counts: { running: 1, queued: 0, attention: 0, plans: 0, total: 1 },
    items: [item()],
    ...overrides,
  };
}

describe('shared voice contracts', () => {
  test('parses the closed response, scope, and browser-audio capability contracts', () => {
    const payload = response();
    assert.deepEqual(voiceBriefingResponseSchema.parse(payload), payload);
    assert.equal(parseVoiceBriefingScope(undefined), 'all');
    assert.deepEqual(VOICE_BRIEFING_SCOPES, ['all', 'running', 'attention']);
    assert.deepEqual(VOICE_BRIEFING_ITEM_KINDS, ['task', 'plan', 'system']);
    assert.deepEqual(VOICE_BRIEFING_ACTIONS, ['open', 'stop', 'follow_up']);
    assert.equal(VOICE_BRIEFING_MAX_ITEMS, 8);
    assert.throws(() => parseVoiceBriefingScope('queued'), /voiceBriefing\.scope/);

    const capabilities = {
      mode: 'on_demand',
      serverAudio: false,
      persistentSession: false,
      rawAudioAccepted: false,
      transcriptStored: false,
    };
    assert.deepEqual(voiceCapabilitiesResponseSchema.parse(capabilities), capabilities);
  });

  test('rejects unsafe links and non-canonical timestamps', () => {
    for (const href of [
      'https://example.test/tasks/task-1',
      '//example.test/tasks/task-1',
      '/tasks\\task-1',
    ]) {
      assert.throws(() => parseVoiceBriefingItem(item(1, { href })), /item\.href/);
    }

    assert.throws(
      () => parseVoiceBriefingItem(item(1, { updatedAt: '2026-09-07 02:30:00' })),
      /item\.updatedAt.*canonical ISO-8601 UTC timestamp/,
    );
    assert.throws(
      () => voiceBriefingResponseSchema.parse(response({
        generatedAt: '2026-09-07T04:30:00+02:00',
      })),
      /generatedAt.*canonical ISO-8601 UTC timestamp/,
    );
  });

  test('rejects invalid references and actions', () => {
    assert.throws(
      () => parseVoiceBriefingItem(item(1, { reference: 'task 2' })),
      /item\.reference/,
    );
    assert.throws(
      () => parseVoiceBriefingItem(item(1, { position: 0, reference: 'task 0' })),
      /item\.position.*positive safe integer/,
    );
    assert.throws(
      () => parseVoiceBriefingItem(item(1, { actions: ['open', 'open'] })),
      /item\.actions.*unique actions/,
    );
    assert.throws(
      () => parseVoiceBriefingItem(item(1, { actions: ['open', 'delete'] })),
      /item\.actions\[1\]/,
    );
    assert.throws(
      () => voiceBriefingResponseSchema.parse(response({
        counts: { running: 2, queued: 0, attention: 0, plans: 0, total: 2 },
        items: [item(1), item(1, { id: 'another-task' })],
      })),
      /items\[1\]\.reference.*unique spoken reference/,
    );
  });

  test('rejects invalid aggregate counts', () => {
    const invalidCounts: Array<[string, unknown]> = [
      ['running', -1],
      ['queued', 1.5],
      ['attention', Number.NaN],
      ['plans', Number.MAX_SAFE_INTEGER + 1],
    ];
    for (const [name, value] of invalidCounts) {
      assert.throws(
        () => voiceBriefingResponseSchema.parse(response({
          counts: {
            running: 1,
            queued: 0,
            attention: 0,
            plans: 0,
            total: 1,
            [name]: value,
          },
        })),
        new RegExp(`counts\\.${name}.*nonnegative safe integer`),
      );
    }

    assert.throws(
      () => voiceBriefingResponseSchema.parse(response({
        counts: { running: 1, queued: 0, attention: 0, plans: 0, total: 0 },
      })),
      /counts\.total.*at least as large as the visible item count/,
    );

    for (const name of ['running', 'queued', 'attention', 'plans']) {
      assert.throws(
        () => voiceBriefingResponseSchema.parse(response({
          counts: {
            running: 0,
            queued: 0,
            attention: 0,
            plans: 0,
            total: 0,
            [name]: 5,
          },
          items: [],
        })),
        /counts\.total.*at least as large as each constituent aggregate count/,
      );
    }
  });

  test('enforces the response item bound and rejects private or log-like fields', () => {
    const maximumItems = Array.from(
      { length: VOICE_BRIEFING_MAX_ITEMS },
      (_, index) => item(index + 1),
    );
    assert.equal(
      voiceBriefingResponseSchema.parse(response({
        counts: {
          running: maximumItems.length,
          queued: 0,
          attention: 0,
          plans: 0,
          total: maximumItems.length,
        },
        items: maximumItems,
      })).items.length,
      VOICE_BRIEFING_MAX_ITEMS,
    );
    assert.throws(
      () => voiceBriefingResponseSchema.parse(response({
        counts: {
          running: maximumItems.length + 1,
          queued: 0,
          attention: 0,
          plans: 0,
          total: maximumItems.length + 1,
        },
        items: [...maximumItems, item(maximumItems.length + 1)],
      })),
      /items.*at most/,
    );

    for (const privateField of ['prompt', 'metadata', 'logs']) {
      const secret = `SECRET ${privateField.toUpperCase()}`;
      assert.throws(
        () => voiceBriefingResponseSchema.parse(response({ [privateField]: secret })),
        new RegExp(`voiceBriefing\\.${privateField}`),
      );
      assert.throws(
        () => voiceBriefingResponseSchema.parse(response({
          items: [item(1, { [privateField]: secret })],
        })),
        new RegExp(`voiceBriefing\\.item\\.${privateField}`),
      );
    }
  });

  test('rejects capability drift and extra capability data', () => {
    const capabilities = {
      mode: 'on_demand',
      serverAudio: false,
      persistentSession: false,
      rawAudioAccepted: false,
      transcriptStored: false,
    } as const;

    for (const override of [
      { mode: 'streaming' },
      { serverAudio: true },
      { persistentSession: true },
      { rawAudioAccepted: true },
      { transcriptStored: true },
    ]) {
      assert.throws(
        () => voiceCapabilitiesResponseSchema.parse({ ...capabilities, ...override }),
        /supported on-demand, browser-audio capability contract/,
      );
    }
    assert.throws(
      () => voiceCapabilitiesResponseSchema.parse({
        ...capabilities,
        providerMetadata: 'SECRET PROVIDER METADATA',
      }),
      /voiceCapabilities\.providerMetadata.*known property/,
    );
  });
});
