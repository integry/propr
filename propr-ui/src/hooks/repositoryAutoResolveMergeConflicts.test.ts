import { describe, expect, it } from 'vitest';
import { buildRepositoriesForDisplay, defaultVisualPreview, updateRepositoryAutoResolveMergeConflicts, type ManagedRepo } from './repositoryVisualPreview';

const repo = (id: string, name: string, autoResolveMergeConflicts?: boolean | null, baseBranch?: string): ManagedRepo => ({
  id, name, enabled: true, baseBranch, autoFollowupOnFailedCi: false, cancelCiDuringFollowup: false,
  cancelCiDuringFollowupWorkflows: [], nonBlockingChecks: [], notificationsEnabled: true, visualPreview: defaultVisualPreview(),
  ...(autoResolveMergeConflicts !== undefined ? { autoResolveMergeConflicts } : {}),
});

describe('repository merge-conflict auto-resolve override', () => {
  it('is one value per repository across its branch entries', () => {
    const repos = [repo('a', 'integry/propr'), repo('b', 'Integry/Propr', undefined, 'next'), repo('c', 'integry/other', false)];
    const always = updateRepositoryAutoResolveMergeConflicts(repos, 'b', true);
    expect(always.map(entry => entry.autoResolveMergeConflicts)).toEqual([true, true, false]);
    const inherit = updateRepositoryAutoResolveMergeConflicts(always, 'a', null);
    expect(inherit.map(entry => entry.autoResolveMergeConflicts)).toEqual([null, null, false]);
  });

  it('displays the stored override, or null when the repository inherits', () => {
    const shown = buildRepositoriesForDisplay([repo('a', 'integry/propr'), repo('b', 'integry/propr', false, 'next'), repo('c', 'integry/other')]);
    expect(shown.map(entry => entry.autoResolveMergeConflicts)).toEqual([false, false, null]);
  });
});
