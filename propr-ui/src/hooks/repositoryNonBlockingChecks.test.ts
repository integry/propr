import { describe, expect, it } from 'vitest';
import { buildRepositoriesForDisplay, defaultVisualPreview, updateRepositoryNonBlockingChecks, type ManagedRepo } from './repositoryVisualPreview';

const repo = (id: string, name: string, nonBlockingChecks: string[], baseBranch?: string): ManagedRepo => ({
  id, name, enabled: true, baseBranch, autoFollowupOnFailedCi: false, cancelCiDuringFollowup: false,
  cancelCiDuringFollowupWorkflows: [], nonBlockingChecks, notificationsEnabled: true, visualPreview: defaultVisualPreview(),
});

describe('repository non-blocking checks', () => {
  it('is one list per repository across its branch entries', () => {
    const repos = [repo('a', 'integry/propr', ['Packaged Connect*']), repo('b', 'Integry/Propr', [], 'next'), repo('c', 'integry/other', ['Keep'])];
    const updated = updateRepositoryNonBlockingChecks(repos, 'b', [' Validate unsigned * package ', 'validate unsigned * package']);
    expect(updated.map(entry => entry.nonBlockingChecks)).toEqual([['Validate unsigned * package'], ['Validate unsigned * package'], ['Keep']]);
  });

  it('displays the union automation honours', () => {
    const shown = buildRepositoriesForDisplay([repo('a', 'integry/propr', ['Packaged Connect*']), repo('b', 'integry/propr', ['Validate unsigned * package'], 'next')]);
    expect(shown[0].nonBlockingChecks).toEqual(['Packaged Connect*', 'Validate unsigned * package']);
    expect(shown[1].nonBlockingChecks).toEqual(shown[0].nonBlockingChecks);
  });
});
