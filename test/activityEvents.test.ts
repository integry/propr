import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVITY_CHANGES,
  ACTIVITY_UPDATE,
  isActivityUpdatePayload,
  isTerminalActivityChange,
  type ActivityUpdatePayload,
} from '../packages/shared/src/activityEvents.js';

const validPayload: ActivityUpdatePayload = {
  eventType: ACTIVITY_UPDATE,
  domain: 'task',
  change: 'completed',
  entityId: 'task-1',
  repository: 'integry/propr',
  terminal: true,
  occurredAt: '2026-09-26T10:00:00.000Z',
};

test('only completed, failed, cancelled and dismissed end a unit of work', () => {
  const terminal = ACTIVITY_CHANGES.filter(isTerminalActivityChange);
  assert.deepEqual(terminal, ['completed', 'failed', 'cancelled', 'dismissed']);
});

test('activity payloads are validated at the Redis trust boundary', () => {
  assert.equal(isActivityUpdatePayload(validPayload), true);
  assert.equal(isActivityUpdatePayload({ ...validPayload, occurredAt: 'yesterday' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, domain: 'invented' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, change: 'invented' }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, entityId: 7 }), false);
  assert.equal(isActivityUpdatePayload({ ...validPayload, eventType: 'task:update' }), false);
  assert.equal(isActivityUpdatePayload(null), false);
  assert.equal(isActivityUpdatePayload('activity:update'), false);
});
