import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  loadOriginalEvidenceCapability,
  normalizeStoredVisualPreviewSettings,
  resolveRepositoryVisualPreviewSettings,
  type RepoToMonitor
} from '../src/config/configManager.js';
import { PREVIEW_STORAGE_V1_DEFAULTS, type ManagedPreviewStorageStatus } from '@propr/shared';
import { db } from '../src/db/connection.js';

after(async () => {
  await db.destroy();
});

test('stored visual preview settings are backward compatible and sanitized', () => {
  assert.deepEqual(normalizeStoredVisualPreviewSettings(undefined), {
    enabled: false,
    types: ['image']
  });
  assert.deepEqual(normalizeStoredVisualPreviewSettings({
    enabled: true,
    types: ['video', 'invalid', 'video'],
    instructions: '  Focus the changed dialog.  '
  }), {
    enabled: true,
    types: ['video'],
    instructions: 'Focus the changed dialog.'
  });
});

test('repository visual preview settings are branch independent', () => {
  const repos: RepoToMonitor[] = [
    { id: 'main', name: 'integry/propr', enabled: true, baseBranch: 'main' },
    {
      id: 'release',
      name: 'INTEGRY/PROPR',
      enabled: true,
      baseBranch: 'release',
      visualPreview: { enabled: true, types: ['image', 'video'], instructions: 'Show both breakpoints.' }
    }
  ];

  assert.deepEqual(resolveRepositoryVisualPreviewSettings(repos, 'integry/propr'), {
    enabled: true,
    types: ['image', 'video'],
    instructions: 'Show both breakpoints.'
  });
  assert.deepEqual(resolveRepositoryVisualPreviewSettings(repos, 'integry/other'), {
    enabled: false,
    types: ['image']
  });
});

test('managed original capacity is derived only from enabled trusted storage status', async () => {
  const effective = {
    version: 1 as const,
    installationId: 42,
    enabled: true,
    ...PREVIEW_STORAGE_V1_DEFAULTS,
    maxObjectBytes: 250 * 1024 ** 2,
    usedBytes: 0,
    reservedBytes: 0,
    allowedContentTypes: ['image/png'],
    deleteSupported: true,
  };
  const enabled: ManagedPreviewStorageStatus = { version: 1, state: 'enabled', enabled: true, effective };
  assert.deepEqual(await loadOriginalEvidenceCapability(async () => enabled), {
    maxBytes: effective.maxObjectBytes,
    allowedContentTypes: ['image/png'],
  });

  for (const status of [
    { version: 1, state: 'disabled', enabled: false, effective: { ...effective, enabled: false } },
    { version: 1, state: 'plus_required', enabled: false, effective: null },
    { version: 1, state: 'unavailable', enabled: false, effective: null },
  ] satisfies ManagedPreviewStorageStatus[]) {
    assert.equal(await loadOriginalEvidenceCapability(async () => status), undefined);
  }
  assert.equal(await loadOriginalEvidenceCapability(async () => { throw new Error('offline'); }), undefined);
});
