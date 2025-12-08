import { Response } from 'express';
import { Knex } from 'knex';
import {
  getGitHubInstallationToken,
  ensureRepoCloned
} from '@gitfix/core';

export interface DbCheckResult {
  valid: false;
  error: string;
  status: number;
}

export interface DbCheckSuccess {
  valid: true;
}

export type DbCheck = DbCheckResult | DbCheckSuccess;

export function checkDbAndAuth(
  isDbEnabled: boolean,
  db: Knex | null,
  userId: string | undefined
): DbCheck {
  if (!isDbEnabled || !db) {
    return { valid: false, error: 'Database not available', status: 503 };
  }
  if (!userId) {
    return { valid: false, error: 'User not authenticated', status: 401 };
  }
  return { valid: true };
}

export function checkAuth(userId: string | undefined): DbCheck {
  if (!userId) {
    return { valid: false, error: 'User not authenticated', status: 401 };
  }
  return { valid: true };
}

export function sendCheckError(res: Response, check: DbCheckResult): void {
  res.status(check.status).json({ error: check.error });
}

export interface OwnershipResult {
  authorized: boolean;
  draft?: Record<string, unknown>;
  error?: string;
  status?: number;
}

export async function verifyDraftOwnership(
  db: Knex,
  draftId: string,
  userId: string,
  selectFields: string[] = ['user_id']
): Promise<OwnershipResult> {
  const existing = await db('task_drafts')
    .select(...selectFields)
    .where({ draft_id: draftId })
    .first();

  if (!existing) {
    return { authorized: false, error: 'Draft not found', status: 404 };
  }

  if (existing.user_id !== userId) {
    return { authorized: false, error: 'Unauthorized', status: 403 };
  }

  return { authorized: true, draft: existing };
}

export interface RepoSetupResult {
  worktreePath: string;
  authToken: string;
}

export async function setupRepoContext(
  draft: { repository: string },
  fallbackToken: string
): Promise<RepoSetupResult> {
  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    return { worktreePath: process.cwd(), authToken: fallbackToken };
  }

  let authToken: string;
  try {
    authToken = await getGitHubInstallationToken();
  } catch {
    authToken = fallbackToken;
  }

  const repoUrl = `https://github.com/${owner}/${repoName}.git`;
  const worktreePath = await ensureRepoCloned(repoUrl, owner, repoName, authToken);

  return { worktreePath, authToken };
}
