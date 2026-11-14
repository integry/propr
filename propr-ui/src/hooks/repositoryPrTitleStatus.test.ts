import { describe, expect, it } from 'vitest';
import {
  buildRepositoriesForDisplay,
  defaultVisualPreview,
  resolveRepositoryPrTitleStatus,
  toggleRepositoryPrTitleStatus,
  type ManagedRepo
} from './repositoryVisualPreview';

const repo = (id: string, name: string, prTitleStatus?: boolean, baseBranch?: string): ManagedRepo => ({
  id, name, enabled: true, baseBranch, autoFollowupOnFailedCi: false, cancelCiDuringFollowup: false,
  cancelCiDuringFollowupWorkflows: [], nonBlockingChecks: [], notificationsEnabled: true,
  autoAssignPullRequests: false, autoAssignDefaultAssignee: null, autoAssignRequestReview: false,
  visualPreview: defaultVisualPreview(), ...(prTitleStatus !== undefined ? { prTitleStatus } : {}),
});

describe('repository PR title status setting', () => {
  it('is on by default and repository-wide across branch entries', () => {
    const repos = [repo('main', 'integry/propr'), repo('dev', 'Integry/Propr', false, 'dev'), repo('other', 'integry/other')];
    expect(resolveRepositoryPrTitleStatus(repos, 'integry/propr')).toBe(false);
    expect(resolveRepositoryPrTitleStatus(repos, 'integry/other')).toBe(true);
    expect(buildRepositoriesForDisplay(repos).map(entry => [entry.id, entry.prTitleStatus])).toEqual([
      ['main', false], ['dev', false], ['other', true],
    ]);
  });

  it('toggles every branch entry of the repository and nothing else', () => {
    const repos = [repo('main', 'integry/propr'), repo('dev', 'integry/propr', true, 'dev'), repo('other', 'integry/other')];
    const off = toggleRepositoryPrTitleStatus(repos, 'dev');
    expect(off.map(entry => [entry.id, entry.prTitleStatus])).toEqual([['main', false], ['dev', false], ['other', undefined]]);
    const on = toggleRepositoryPrTitleStatus(off, 'main');
    expect(on.map(entry => [entry.id, entry.prTitleStatus])).toEqual([['main', true], ['dev', true], ['other', undefined]]);
    expect(toggleRepositoryPrTitleStatus(repos, 'missing')).toBe(repos);
  });
});
