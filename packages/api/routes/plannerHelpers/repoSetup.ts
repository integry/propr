/**
 * Repository setup utilities.
 */

import { Knex } from 'knex';
import { getGitHubInstallationToken, ensureRepoCloned } from '@propr/core';
import type { RepoSetupResult } from './types.js';

export async function setupRepoContext(
  draft: { repository: string },
  fallbackToken: string
): Promise<RepoSetupResult> {
  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
  }

  let authToken: string;
  try {
    authToken = await getGitHubInstallationToken();
  } catch {
    authToken = fallbackToken;
  }

  const repoUrl = `https://github.com/${owner}/${repoName}.git`;
  const worktreePath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken });

  return { worktreePath, authToken, repository: draft.repository };
}

export async function getRefineRepoContext(
  db: Knex,
  draftId: string | undefined,
  fallbackToken: string
): Promise<RepoSetupResult> {
  if (!draftId) {
    return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
  }
  const draft = await db('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) return { worktreePath: process.cwd(), authToken: fallbackToken, repository: 'unknown/unknown' };
  return setupRepoContext(draft, fallbackToken);
}
