import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import {
  createSessionAuthGeneration,
  getSessionAuthGeneration,
} from '../authSessionGeneration.js';

test('session entitlement generations are stable without persisting session IDs', () => {
  const request = { sessionID: 'sensitive-session-id' } as Request;
  const generation = getSessionAuthGeneration(request);

  assert.equal(generation, getSessionAuthGeneration(request));
  assert.equal(generation, createSessionAuthGeneration(request.sessionID));
  assert.match(generation, /^session-sha256:[a-f0-9]{64}$/);
  assert.equal(generation.includes(request.sessionID), false);
});

test('session entitlement generation rejects a missing session identity', () => {
  assert.throws(
    () => getSessionAuthGeneration({ sessionID: ' ' } as Request),
    /missing its session generation/
  );
});
