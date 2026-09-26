import type * as configManager from '@propr/core';
import { withDefaultRepoOptions } from './configRepoValidation.js';

type RepoConfigStore = Pick<typeof configManager, 'loadMonitoredReposRaw' | 'loadGitHubAttachmentCapacity'>;

export async function loadReposWithAttachmentCapacity(configStore: RepoConfigStore) {
  const repos = (await configStore.loadMonitoredReposRaw()).map(withDefaultRepoOptions);
  return Promise.all(repos.map(async repo => {
    const plan = repo.visualPreview?.githubAttachmentPlan ?? 'auto';
    return {
      ...repo,
      visualPreview: {
        ...repo.visualPreview!,
        githubAttachmentPlan: plan,
        githubAttachmentCapacity: await configStore.loadGitHubAttachmentCapacity(plan, repo.name),
      },
    };
  }));
}
