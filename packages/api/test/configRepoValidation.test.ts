import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRepoConfig, preserveRepoCancelCiDuringFollowup, preserveRepoCancelCiWorkflows, withDefaultRepoOptions } from '../routes/configRepoValidation.js';

test('repository config defaults missing automatic failed-CI follow-up to false', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.equal(normalized.value.autoFollowupOnFailedCi, false);
    assert.equal(normalized.value.notificationsEnabled, true);
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

test('repository config defaults omitted visual preview types', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    visualPreview: { enabled: false }
  });

  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.deepEqual(normalized.value.visualPreview, { enabled: false, types: ['image'] });
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

test('validates attachment override and ignores client-supplied effective capacity', () => {
  for (const plan of ['auto', 'free', 'paid']) {
    const result = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, visualPreview: { enabled: true, types: ['video'], githubAttachmentPlan: plan, githubAttachmentCapacity: { effectivePlan: 'paid' } } });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.visualPreview?.githubAttachmentPlan, plan);
      assert.equal(result.value.visualPreview?.githubAttachmentCapacity, undefined);
    }
  }
  for (const plan of ['invalid', '', null, true, 100]) {
    const result = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, visualPreview: { enabled: true, types: ['video'], githubAttachmentPlan: plan } });
    assert.equal(result.ok, false);
  }
});

test('repository config accepts an explicit notification opt-out', () => {
  for (const notificationsEnabled of [true, false]) {
    const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, notificationsEnabled });
    assert.equal(normalized.ok, true);
    if (normalized.ok) assert.equal(normalized.value.notificationsEnabled, notificationsEnabled);
  }
});

test('repository config rejects non-boolean notificationsEnabled values', () => {
  for (const notificationsEnabled of ['false', 0, null, {}]) {
    const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true, notificationsEnabled });
    assert.equal(normalized.ok, false);
    if (!normalized.ok) assert.match(normalized.error, /notificationsEnabled.*must be a boolean/);
  }
});

test('repository config defaults and accepts the follow-up CI cancellation option', () => {
  const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true });
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(normalized.value.cancelCiDuringFollowup, false);

  for (const cancelCiDuringFollowup of [true, false]) {
    const explicit = normalizeRepoConfig({
      id: `repo-${cancelCiDuringFollowup}`,
      name: 'integry/propr',
      enabled: true,
      cancelCiDuringFollowup
    });
    assert.equal(explicit.ok, true);
    if (explicit.ok) assert.equal(explicit.value.cancelCiDuringFollowup, cancelCiDuringFollowup);
  }
});

test('repository config rejects a non-boolean follow-up CI cancellation option', () => {
  const normalized = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    cancelCiDuringFollowup: 'yes'
  });

  assert.equal(normalized.ok, false);
  if (!normalized.ok) assert.match(normalized.error, /cancelCiDuringFollowup/);
});

test('an omitted follow-up CI cancellation option keeps the stored value', () => {
  const previous = [
    { id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowup: true }
  ] as never;
  const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;

  const preserved = preserveRepoCancelCiDuringFollowup(
    previous,
    [normalized.value],
    [{ id: 'repo-1', name: 'integry/propr', enabled: true }]
  );

  assert.equal(preserved[0].cancelCiDuringFollowup, true);
});

test('repository defaults materialize the follow-up CI cancellation option for legacy entries', () => {
  const materialized = withDefaultRepoOptions({ id: 'repo-1', name: 'integry/propr', enabled: true } as never);
  assert.equal(materialized.cancelCiDuringFollowup, false);
  assert.deepEqual(materialized.cancelCiDuringFollowupWorkflows, []);
});

test('repository config normalizes the selected validation workflows and defaults to none', () => {
  const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true });
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.deepEqual(normalized.value.cancelCiDuringFollowupWorkflows, []);

  const selected = normalizeRepoConfig({
    id: 'repo-1',
    name: 'integry/propr',
    enabled: true,
    cancelCiDuringFollowup: true,
    // Trimmed, de-duplicated case-insensitively, empty entries dropped; order is the operator's.
    cancelCiDuringFollowupWorkflows: ['  pr-build-check.yml ', '', 'PR-Build-Check.yml', 'Full Test Suite']
  });
  assert.equal(selected.ok, true);
  if (selected.ok) assert.deepEqual(selected.value.cancelCiDuringFollowupWorkflows, ['pr-build-check.yml', 'Full Test Suite']);
});

test('repository config rejects a malformed validation workflow selection', () => {
  for (const cancelCiDuringFollowupWorkflows of ['pr-build-check.yml', [42], [{ name: 'x' }], ['a'.repeat(256)], Array.from({ length: 51 }, (_, index) => `w-${index}.yml`)]) {
    const normalized = normalizeRepoConfig({
      id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowupWorkflows
    });
    assert.equal(normalized.ok, false);
    if (!normalized.ok) assert.match(normalized.error, /cancelCiDuringFollowupWorkflows/);
  }
});

test('an omitted validation workflow selection keeps the stored selection', () => {
  const previous = [
    { id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowup: true, cancelCiDuringFollowupWorkflows: ['pr-build-check.yml'] }
  ] as never;
  const normalized = normalizeRepoConfig({ id: 'repo-1', name: 'integry/propr', enabled: true });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;

  // An older client submits the repository without the field at all.
  const preserved = preserveRepoCancelCiWorkflows(
    previous,
    [normalized.value],
    [{ id: 'repo-1', name: 'integry/propr', enabled: true }]
  );
  assert.deepEqual(preserved[0].cancelCiDuringFollowupWorkflows, ['pr-build-check.yml']);

  // A client that does send it decides, including when it clears the selection.
  const cleared = preserveRepoCancelCiWorkflows(
    previous,
    [{ ...normalized.value, cancelCiDuringFollowupWorkflows: [] }],
    [{ id: 'repo-1', name: 'integry/propr', enabled: true, cancelCiDuringFollowupWorkflows: [] }]
  );
  assert.deepEqual(cleared[0].cancelCiDuringFollowupWorkflows, []);
});
