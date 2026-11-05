import { describe, expect, it } from 'vitest';
import {
  buildRepositoriesForDisplay,
  defaultVisualPreview,
  parseAutoAssignDefaultAssignee,
  resolveRepositoryAutoAssign,
  toggleRepositoryAutoAssign,
  toggleRepositoryAutoAssignReview,
  updateRepositoryAutoAssignTarget,
  type ManagedRepo
} from './repositoryVisualPreview';

const repo = (id: string, name: string, autoAssign: Partial<Pick<ManagedRepo, 'autoAssignPullRequests' | 'autoAssignDefaultAssignee' | 'autoAssignRequestReview'>> = {}, baseBranch?: string): ManagedRepo => ({
  id, name, enabled: true, baseBranch, autoFollowupOnFailedCi: false, cancelCiDuringFollowup: false,
  cancelCiDuringFollowupWorkflows: [], nonBlockingChecks: [], notificationsEnabled: true,
  autoAssignPullRequests: false, autoAssignDefaultAssignee: null, autoAssignRequestReview: false,
  visualPreview: defaultVisualPreview(), ...autoAssign,
});

const autoAssignOf = (repos: ManagedRepo[]) => repos.map(entry => [entry.id, entry.autoAssignPullRequests, entry.autoAssignDefaultAssignee, entry.autoAssignRequestReview]);

describe('repository automatic pull request assignment', () => {
  it('parses a default assignee the way the server stores it', () => {
    expect(parseAutoAssignDefaultAssignee(' @octocat ')).toBe('octocat');
    expect(parseAutoAssignDefaultAssignee('')).toBeNull();
    expect(parseAutoAssignDefaultAssignee(null)).toBeNull();
    expect(parseAutoAssignDefaultAssignee('not a login')).toBeUndefined();
    expect(parseAutoAssignDefaultAssignee('-leading-hyphen')).toBeUndefined();
  });

  it('resolves one repository-wide state across branch entries, matching names case-insensitively', () => {
    const repos = [
      repo('main', 'integry/propr', {}, 'main'),
      repo('release', 'Integry/ProPR', { autoAssignPullRequests: true, autoAssignDefaultAssignee: 'octocat' }, 'release'),
      repo('sdk', 'integry/sdk'),
    ];
    expect(resolveRepositoryAutoAssign(repos, 'integry/propr')).toEqual({ enabled: true, defaultAssignee: 'octocat', requestReview: false });
    expect(autoAssignOf(buildRepositoriesForDisplay(repos))).toEqual([
      ['main', true, 'octocat', false], ['release', true, 'octocat', false], ['sdk', false, null, false],
    ]);
  });

  it('applies every change to all branch entries of the repository only', () => {
    let repos = [repo('main', 'integry/propr', {}, 'main'), repo('release', 'integry/propr', {}, 'release'), repo('sdk', 'integry/sdk')];
    repos = toggleRepositoryAutoAssign(repos, 'release');
    repos = updateRepositoryAutoAssignTarget(repos, 'main', '@octocat');
    repos = toggleRepositoryAutoAssignReview(repos, 'main');
    expect(autoAssignOf(repos)).toEqual([
      ['main', true, 'octocat', true], ['release', true, 'octocat', true], ['sdk', false, null, false],
    ]);

    // Turning assignment off keeps the stored assignee and review choice.
    repos = toggleRepositoryAutoAssign(repos, 'main');
    expect(autoAssignOf(repos)).toEqual([
      ['main', false, 'octocat', true], ['release', false, 'octocat', true], ['sdk', false, null, false],
    ]);

    repos = updateRepositoryAutoAssignTarget(repos, 'release', '');
    expect(repos.map(entry => entry.autoAssignDefaultAssignee)).toEqual([null, null, null]);
  });

  it('ignores an invalid login and an unknown repository', () => {
    const repos = [repo('main', 'integry/propr', { autoAssignDefaultAssignee: 'octocat' })];
    expect(updateRepositoryAutoAssignTarget(repos, 'main', 'not a login')).toBe(repos);
    expect(toggleRepositoryAutoAssign(repos, 'missing')).toBe(repos);
    expect(toggleRepositoryAutoAssignReview(repos, 'missing')).toBe(repos);
  });
});
