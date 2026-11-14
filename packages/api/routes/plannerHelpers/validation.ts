/**
 * Input validation utilities.
 */

import type { Knex } from 'knex';
import { normalizePlanItems, type PlanItemGraphError } from '@propr/shared';
import type { ContextRepositoryInput } from './types.js';

export const VALID_GRANULARITIES = ['single', 'balanced', 'granular'] as const;
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/;

export function validateContextRepositories(
  repos: unknown
): { valid: boolean; error?: string; repositories?: ContextRepositoryInput[] } {
  if (!repos) {
    return { valid: true, repositories: [] };
  }

  if (!Array.isArray(repos)) {
    return { valid: false, error: 'contextRepositories must be an array' };
  }

  const validated: ContextRepositoryInput[] = [];

  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') {
      return { valid: false, error: 'Each context repository must be an object' };
    }

    if (!repo.repository || typeof repo.repository !== 'string') {
      return { valid: false, error: 'Each context repository must have a repository field' };
    }

    // Validate repository format (owner/repo)
    if (!repo.repository.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/)) {
      return { valid: false, error: `Invalid repository format: ${repo.repository}` };
    }

    validated.push({
      repository: repo.repository,
      branch: typeof repo.branch === 'string' ? repo.branch : undefined,
      description: typeof repo.description === 'string' ? repo.description : undefined
    });
  }

  return { valid: true, repositories: validated };
}

export function validateRefineInput(body: Record<string, unknown>): { valid: boolean; error?: string } {
  const { draftId, plan, instruction, generationModel } = body;
  if (!draftId) return { valid: false, error: 'draftId is required' };
  if (!plan || !Array.isArray(plan)) return { valid: false, error: 'currentPlan array is required' };
  if (!instruction || typeof instruction !== 'string') return { valid: false, error: 'instruction is required' };
  if (generationModel !== undefined && typeof generationModel !== 'string') return { valid: false, error: 'generationModel must be a string' };
  return { valid: true };
}

export function validatePreviewInput(body: Record<string, unknown>): { valid: boolean; error?: string } {
  const { draftId, prompt, baseBranch, granularity, files, contextRepositories, excludedFiles } = body;
  if (!draftId) return { valid: false, error: 'draftId is required' };
  if (!prompt || typeof prompt !== 'string') return { valid: false, error: 'prompt is required' };
  if (!baseBranch || typeof baseBranch !== 'string') return { valid: false, error: 'baseBranch is required' };
  if (!BRANCH_NAME_REGEX.test(baseBranch as string)) return { valid: false, error: 'Invalid branch name format' };
  if (granularity && !VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number])) return { valid: false, error: `granularity must be one of: ${VALID_GRANULARITIES.join(', ')}` };
  if (files && (!Array.isArray(files) || !files.every(f => typeof f === 'string'))) return { valid: false, error: 'files must be an array of strings' };
  if (excludedFiles && (!Array.isArray(excludedFiles) || !excludedFiles.every(f => typeof f === 'string'))) return { valid: false, error: 'excludedFiles must be an array of strings' };

  // Validate context repositories if provided
  if (contextRepositories !== undefined) {
    const repoValidation = validateContextRepositories(contextRepositories);
    if (!repoValidation.valid) {
      return { valid: false, error: repoValidation.error };
    }
  }

  return { valid: true };
}

export type PreparedPlan =
  | { valid: true; plan: unknown[]; submitted: string; serialized: string }
  | { valid: false; error: string; errors: PlanItemGraphError[] };

/**
 * Checks a plan before it is stored, for REST and MCP alike: items without an
 * id get one, existing ids are kept, and duplicate ids or `dependsOn` entries
 * that name no item, the item itself, or form a cycle are rejected with an
 * error naming the item.
 */
export function preparePlanForStorage(plan: unknown[]): PreparedPlan {
  const normalized = normalizePlanItems(plan);
  if (!normalized.ok) return { valid: false, error: normalized.message, errors: normalized.errors };
  return { valid: true, plan: normalized.plan, submitted: JSON.stringify(plan), serialized: JSON.stringify(normalized.plan) };
}

/**
 * Columns that store a prepared plan with `cause` as its provenance. A
 * submission identical to the stored plan, as submitted, changes nothing:
 * neither its provenance, nor its history, nor (by assigning ids) its bytes.
 */
export function planStorageUpdates(db: Knex, prepared: Extract<PreparedPlan, { valid: true }>, cause: string): Record<string, unknown> {
  return {
    plan_json: db.raw('CASE WHEN ?? = ? THEN ?? ELSE ? END', ['plan_json', prepared.submitted, 'plan_json', prepared.serialized]),
    plan_cause: db.raw('CASE WHEN ?? IN (?, ?) THEN ?? ELSE ? END',
      ['plan_json', prepared.submitted, prepared.serialized, 'plan_cause', cause]),
  };
}
