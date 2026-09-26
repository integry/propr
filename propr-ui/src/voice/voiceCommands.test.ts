import type {
  VoiceBriefingItem,
  VoiceBriefingResponse,
} from '@propr/shared';
import { describe, expect, test } from 'vitest';
import {
  MAX_VOICE_FOLLOW_UP_INSTRUCTION_LENGTH,
  parseVoiceCommand,
} from './voiceCommands';

const NOW = '2026-09-07T05:00:00.000Z' as VoiceBriefingResponse['generatedAt'];

function item(
  kind: VoiceBriefingItem['kind'],
  position: number,
  actions: VoiceBriefingItem['actions'],
): VoiceBriefingItem {
  return {
    reference: `${kind} ${position}`,
    position,
    kind,
    id: `${kind}-${position}`,
    title: `${kind} ${position}`,
    repository: kind === 'system' ? null : 'integry/propr',
    status: kind === 'task' ? 'running' : 'review',
    summary: `${kind} ${position} status.`,
    href: `/${kind}/${position}`,
    requiresAttention: kind !== 'task',
    actions,
    updatedAt: NOW,
  };
}

const taskOne = item('task', 1, ['open']);
const taskTwo = item('task', 2, ['open', 'stop']);
const planOne = item('plan', 1, ['open', 'follow_up']);
const systemOne = item('system', 1, []);
const spokenNumbers = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

const briefing: VoiceBriefingResponse = {
  generatedAt: NOW,
  scope: 'all',
  headline: 'Latest status.',
  speechText: 'Latest status.',
  counts: { running: 2, queued: 0, attention: 2, plans: 1, total: 4 },
  items: [taskOne, planOne, taskTwo, systemOne],
};

describe('voice command parser', () => {
  test.each([
    ['Catch me up.', { type: 'briefing', scope: 'all' }],
    ['what is running?', { type: 'briefing', scope: 'running' }],
    ['What needs attention', { type: 'briefing', scope: 'attention' }],
    ['repeat that', { type: 'repeat' }],
    ['confirm', { type: 'confirm' }],
    ['cancel', { type: 'cancel' }],
  ])('parses the fixed command phrase %s', (transcript, expected) => {
    expect(parseVoiceCommand(transcript, briefing)).toEqual(expected);
  });

  test('resolves numeric references by kind and response position', () => {
    expect(parseVoiceCommand('open plan 1', briefing)).toEqual({
      type: 'open',
      item: planOne,
    });
    expect(parseVoiceCommand('open system one', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('does not advertise'),
    });
    expect(parseVoiceCommand('stop task two', briefing)).toEqual({
      type: 'pending_action',
      action: 'stop',
      item: taskTwo,
      requiresConfirmation: true,
    });
  });

  test.each(spokenNumbers)(
    'resolves the spoken-number reference %s',
    (spokenNumber) => {
      const spokenNumberBriefing = {
        ...briefing,
        items: spokenNumbers.map((_, index) => item('task', index + 1, ['open'])),
      };
      const position = spokenNumbers.indexOf(spokenNumber) + 1;

      expect(parseVoiceCommand(`open task ${spokenNumber}`, spokenNumberBriefing)).toEqual({
        type: 'open',
        item: spokenNumberBriefing.items[position - 1],
      });
    },
  );

  test('creates a bounded pending follow-up without changing the selected item', () => {
    const followUpTask: VoiceBriefingItem = {
      ...taskOne,
      actions: ['open', 'follow_up'],
    };
    const followUpBriefing = {
      ...briefing,
      items: [followUpTask, planOne, taskTwo, systemOne],
    };
    expect(parseVoiceCommand('Follow up task one to Rerun tests', followUpBriefing)).toEqual({
      type: 'pending_action',
      action: 'follow_up',
      item: followUpTask,
      instruction: 'Rerun tests',
      requiresConfirmation: true,
    });
    expect(parseVoiceCommand(
      'follow up plan one to write the word please',
      briefing,
    )).toMatchObject({
      type: 'pending_action',
      instruction: 'write the word please',
    });
    expect(parseVoiceCommand('follow up plan one to rerun 2 tests', briefing)).toMatchObject({
      type: 'pending_action',
      instruction: 'rerun 2 tests',
    });
    expect(parseVoiceCommand(
      'follow up plan one to summarize risks: then rerun tests',
      briefing,
    )).toMatchObject({
      type: 'pending_action',
      instruction: 'summarize risks: then rerun tests',
    });

    const maximum = 'x'.repeat(MAX_VOICE_FOLLOW_UP_INSTRUCTION_LENGTH);
    expect(parseVoiceCommand(`follow up plan 1 to ${maximum}`, briefing)).toMatchObject({
      type: 'pending_action',
      instruction: maximum,
    });
    expect(parseVoiceCommand(`follow up plan 1 to ${maximum}x`, briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('1,000 characters'),
    });
  });

  test('rejects actions not advertised by the referenced item', () => {
    expect(parseVoiceCommand('follow up task one to rerun tests', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('does not advertise the follow-up action'),
    });
    expect(parseVoiceCommand('stop system one', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('does not advertise the stop action'),
    });
  });

  test('returns explanatory errors for missing, out-of-range, and ambiguous references', () => {
    expect(parseVoiceCommand('open task one')).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('briefing first'),
    });
    expect(parseVoiceCommand('open task 9', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('not in the latest briefing'),
    });
    expect(parseVoiceCommand('open one', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('task, plan, or system'),
    });

    const duplicateBriefing = { ...briefing, items: [taskOne, { ...taskOne }] };
    expect(parseVoiceCommand('open task one', duplicateBriefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('ambiguous'),
    });
  });

  test('never derives navigation or API endpoints from a transcript', () => {
    expect(parseVoiceCommand('open https://example.test/task/1', briefing)).toMatchObject({
      type: 'invalid',
    });
    expect(parseVoiceCommand(
      'follow up plan one to send results to https://example.test',
      briefing,
    )).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
    expect(parseVoiceCommand('follow up plan one to POST /api/admin', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
    expect(parseVoiceCommand('follow up plan one to POST /api#fragment', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
    expect(parseVoiceCommand('follow up plan one to POST /v1/run', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
    expect(parseVoiceCommand('follow up plan one to inspect /internal/admin', briefing)).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
    expect(parseVoiceCommand(
      'follow up plan one to check example.com/results',
      briefing,
    )).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
    expect(parseVoiceCommand(
      'follow up plan one to email mailto:ops@example.com',
      briefing,
    )).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
  });

  test.each([
    'send results to 127.0.0.1:3000/admin',
    'send results to 10.0.0.25/v1/run',
    'send results to 127.1',
    'send results to 127.0.1',
    'send results to 2130706433',
    'send results to 0x7f000001',
    'send results to 127.1/admin',
    'send results to 2130706433/admin',
    'send results to 0x7f000001/admin',
    'send results to 0177.0.0.1/admin',
    'send results to localhost:8080/v1/run',
    'send results to localhost/admin',
    'send results to build-agent:8080/v1/run',
    'send results to build-agent/admin',
    'send results to 例え.テスト',
    'send results to 例え.テスト/results',
    'send results to example。com',
    'send results to example．com/results',
    'send results to example｡com',
    'send results to [::1]:8080/v1/run',
    'send results to 2001:db8::1',
    'send results to [2001:db8::2]/admin',
  ])('rejects a follow-up containing the network endpoint %s', instruction => {
    expect(parseVoiceCommand(
      `follow up plan one to ${instruction}`,
      briefing,
    )).toMatchObject({
      type: 'invalid',
      reason: expect.stringContaining('URL or API endpoint'),
    });
  });

  test('does not interpret unknown or compound commands', () => {
    expect(parseVoiceCommand('delete task one', briefing)).toMatchObject({ type: 'invalid' });
    expect(parseVoiceCommand('stop task two and open plan one', briefing)).toMatchObject({
      type: 'invalid',
    });
  });

  test.each(['constructor', '__proto__'])(
    'returns an invalid command for the prototype property name %s',
    transcript => {
      expect(parseVoiceCommand(transcript, briefing)).toEqual({
        type: 'invalid',
        reason: expect.any(String),
      });
    },
  );
});
