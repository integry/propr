import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRepoConfig } from '../routes/configRepoValidation.js';

test('repository config defaults missing automatic failed-CI follow-up to false', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.equal(normalized.value.autoFollowupOnFailedCi, false);
    assert.deepEqual(normalized.value.visualPreview, { enabled: false, types: ['image'] });
  }
});

test('repository config accepts visual preview types and trims instructions', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    visualPreview: {
      enabled: true,
      types: ['video', 'image', 'video'],
      instructions: '  Capture desktop and mobile views.  '
    }
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.deepEqual(normalized.value.visualPreview, {
      enabled: true,
      types: ['video', 'image'],
      instructions: 'Capture desktop and mobile views.'
    });
  }
});

test('repository config rejects invalid visual preview settings', () => {
  const invalidValues = [
    { enabled: 'true', types: ['image'] },
    { enabled: true, types: [] },
    { enabled: true, types: ['animation'] },
    { enabled: true, types: ['image'], instructions: 42 }
  ];

  for (const visualPreview of invalidValues) {
    const normalized = normalizeRepoConfig({
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      visualPreview
    });
    assert.equal(normalized.ok, false);
    if (!normalized.ok) assert.match(normalized.error, /visualPreview/);
  }
});

test('repository config accepts explicit automatic failed-CI follow-up booleans', () => {
  for (const autoFollowupOnFailedCi of [true, false]) {
    const normalized = normalizeRepoConfig({
      id: `repo-${autoFollowupOnFailedCi}`,
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi
    });

    assert.equal(normalized.ok, true);
    if (normalized.ok) {
      assert.equal(normalized.value.autoFollowupOnFailedCi, autoFollowupOnFailedCi);
    }
  }
});

test('repository config rejects non-boolean automatic failed-CI follow-up values', () => {
  for (const autoFollowupOnFailedCi of ['true', 1, null, {}]) {
    const normalized = normalizeRepoConfig({
      id: 'repo-1',
      name: 'integry/propr',
      enabled: true,
      autoFollowupOnFailedCi
    });

    assert.equal(normalized.ok, false);
    if (!normalized.ok) {
      assert.match(normalized.error, /autoFollowupOnFailedCi.*must be a boolean/);
    }
  }
});
