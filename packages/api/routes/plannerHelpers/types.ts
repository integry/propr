/**
 * Type definitions for planner helpers.
 */

import { Request, Response } from 'express';

export interface DbCheckResult {
  valid: false;
  error: string;
  status: number;
}

export interface DbCheckSuccess {
  valid: true;
}

export type DbCheck = DbCheckResult | DbCheckSuccess;

export type HandlerFunction = (req: Request, res: Response) => Promise<void>;

export interface OwnershipResult {
  authorized: boolean;
  draft?: Record<string, unknown>;
  error?: string;
  status?: number;
}

export interface RepoSetupResult {
  worktreePath: string;
  authToken: string;
  repository: string;
}

export interface ContextRepositoryInput {
  repository: string;
  branch?: string;
  description?: string;
}

export interface GenerateRequestBody {
  draftId?: string;
  baseBranch?: string;
  granularity?: string;
  contextLevel?: number;
  compress?: boolean;
  contextRepositories?: ContextRepositoryInput[];
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  generationModel?: string;
}

export interface BackgroundGenerationOptions {
  db: import('knex').Knex;
  draftId: string;
  worktreePath: string;
  authToken: string;
  correlationId: string;
}

export interface ValidateContextRepositoryResponse {
  valid: boolean;
  repository: string;
  defaultBranch?: string;
  description?: string;
  error?: string;
}
