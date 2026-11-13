import { describe, expect, it } from 'vitest';
import {
  buildRepositoriesForDisplay,
  defaultVisualPreview,
  resolveRepositoryPrStatusDisplay,
  toggleRepositoryPrStatusDisplay,
  type ManagedRepo
} from './repositoryVisualPreview';

const repo = (id: string, name: string, prStatusDisplay?: boolean, baseBranch?: string): ManagedRepo => ({
  id, name, enabled: true, baseBranch, autoFollowupOnFailedCi: false, cancelCiDuringFollowup: false,
  cancelCiDuringFollowupWorkflows: [], nonBlockingChecks: [], notificationsEnabled: true,
  autoAssignPullRequests: false, autoAssignDefaultAssignee: null, autoAssignRequestReview: false,
  visualPreview: defaultVisualPreview(), ...(prStatusDisplay !== undefined ? { prStatusDisplay } : {}),
});

describe('repository PR status block setting', () => {
  it('is off by default and repository-wide across branch entries', () => {
    const repos = [repo('main', 'integry/propr'), repo('dev', 'Integry/Propr', true, 'dev'), repo('other', 'integry/other')];
    expect(resolveRepositoryPrStatusDisplay(repos, 'integry/propr')).toBe(true);
    expect(resolveRepositoryPrStatusDisplay(repos, 'integry/other')).toBe(false);
    expect(buildRepositoriesForDisplay(repos).map(entry => [entry.id, entry.prStatusDisplay])).toEqual([
      ['main', true], ['dev', true], ['other', false],
    ]);
  });

  it('toggles every branch entry of the repository and nothing else', () => {
    const repos = [repo('main', 'integry/propr'), repo('dev', 'integry/propr', false, 'dev'), repo('other', 'integry/other')];
    const on = toggleRepositoryPrStatusDisplay(repos, 'dev');
    expect(on.map(entry => [entry.id, entry.prStatusDisplay])).toEqual([['main', true], ['dev', true], ['other', undefined]]);
    const off = toggleRepositoryPrStatusDisplay(on, 'main');
    expect(off.map(entry => [entry.id, entry.prStatusDisplay])).toEqual([['main', false], ['dev', false], ['other', undefined]]);
    expect(toggleRepositoryPrStatusDisplay(repos, 'missing')).toBe(repos);
  });
});
