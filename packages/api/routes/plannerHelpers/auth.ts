/**
 * Authentication and authorization utilities.
 */

import { Response } from 'express';
import { Knex } from 'knex';
import { getGitHubInstallationToken } from '@propr/core';
import { isDemoDraftOwnerIdVisible, isDemoMode } from '../../demoMode.js';
import { loadDemoConfiguredRepoNames } from '../demoRepositoryMetadata.js';
import type { DbCheck, DbCheckResult, HandlerFunction, OwnershipResult } from './types.js';

export function checkDbAndAuth(
  db: Knex,
  userId: string | undefined
): DbCheck {
  if (!userId) {
    return { valid: false, error: 'User not authenticated', status: 401 };
  }
  return { valid: true };
}

export function withAuthCheck(db: Knex, handler: HandlerFunction): HandlerFunction {
  return async (req, res): Promise<void> => {
    const check = checkDbAndAuth(db, req.user?.id);
    if (!check.valid) { sendCheckError(res, check); return; }
    return handler(req, res);
  };
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

export async function verifyDraftOwnership(
  db: Knex,
  draftId: string,
  userId: string,
  selectFields: string[] = ['user_id']
): Promise<OwnershipResult> {
  // Always include ownership and repository fields for authorization checks.
  const requiredFields = isDemoMode() ? ['user_id', 'repository'] : ['user_id'];
  const fieldsWithUserId = Array.from(new Set([...requiredFields, ...selectFields]));
  const existing = await db('task_drafts')
    .select(...fieldsWithUserId)
    .where({ draft_id: draftId })
    .first();

  if (!existing) {
    return { authorized: false, error: 'Draft not found', status: 404 };
  }

  if (isDemoMode()) {
    const visibleRepos = await loadDemoConfiguredRepoNames();
    if (!isDemoDraftOwnerIdVisible(existing.user_id) || !visibleRepos.includes(existing.repository)) {
      return { authorized: false, error: 'Draft not found', status: 404 };
    }
  } else if (existing.user_id !== userId) {
    return { authorized: false, error: 'Unauthorized', status: 403 };
  }

  return { authorized: true, draft: existing };
}

export async function getRepoAuthToken(accessToken: string): Promise<string> {
  try { return await getGitHubInstallationToken(); } catch { return accessToken; }
}
