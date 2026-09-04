import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  normalizeStoredVisualPreviewSettings,
  resolveRepositoryVisualPreviewSettings,
  type RepoToMonitor
} from '../src/config/configManager.js';
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
