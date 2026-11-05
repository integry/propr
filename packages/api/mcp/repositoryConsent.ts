import { createElement as h, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getRepositoriesIndexingStatus, loadMonitoredReposRaw, type RepoToMonitor, type RepositoryIndexingStatus } from '@propr/core';
import { RepositoryGroups, RepositoryRow, sortRepositories, type RepositoryOption } from '@propr/shared/dist/repositoryPresentation.js';
import { RepositoryIcon, RepositoryIconFallback } from '@propr/shared/dist/repositoryIcon.js';
import { buildRepositoryIconUrl } from '@propr/shared/dist/repositoryIconUrl.js';
import type { Knex } from 'knex';
import { getUserRepoPrefs, type UserRepoPreferences } from '../routes/userRepoPreferencesRoutes.js';

/** Metadata only: the caller supplies the complete, independently authorized set of names. */
export async function loadConsentRepositories(names: string[], userId: string, db: Knex): Promise<RepositoryOption[]> {
  const [configured, statuses, preferences] = await Promise.all([
    loadMonitoredReposRaw(),
    getRepositoriesIndexingStatus().catch(() => []),
    getUserRepoPrefs(userId, db),
  ]);
  return buildConsentRepositories(names, configured, statuses, preferences);
}

export function buildConsentRepositories(names: string[], configured: RepoToMonitor[], statuses: RepositoryIndexingStatus[], preferences: UserRepoPreferences): RepositoryOption[] {
  return names.map(name => {
    const repo = configured.find(repo => repo.name === name && repo.enabled);
    const status = statuses.find(status => status.full_name === name && (status.branch || 'HEAD') === (repo?.baseBranch || 'HEAD'));
    return {
      name,
      starred: preferences[name]?.starred === true,
      iconPath: status?.icon_path,
      iconRevision: status?.last_indexed_hash || repo?.baseBranch || 'HEAD',
    };
  });
}

export function renderConsentRepositories(repos: RepositoryOption[]): string {
  return renderToStaticMarkup(h(RepositoryGroups<RepositoryOption>, {
    starredRepos: sortRepositories(repos.filter(repo => repo.starred)),
    otherRepos: sortRepositories(repos.filter(repo => !repo.starred)),
    renderRow: repo => h(RepositoryRow, {
      repo,
      control: h('input', { type: 'checkbox', name: 'repositories', value: repo.name, 'aria-label': repo.name }),
      icon: h(Fragment, null,
        h(RepositoryIcon, { repository: repo.name, iconPath: repo.iconPath, revision: repo.iconRevision, className: 'propr-repo-icon' }),
        // Static HTML has no React handlers. The nonce script reveals this same fallback on error.
        repo.iconPath && buildRepositoryIconUrl(repo.name, repo.iconPath, repo.iconRevision || 'HEAD') && h('span', { hidden: true, 'data-repository-icon-fallback': true },
          h(RepositoryIconFallback, { className: 'propr-repo-icon' }))),
    }),
  }));
}
