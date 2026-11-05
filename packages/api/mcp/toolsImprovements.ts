import { z } from 'zod';
import { generateCorrelationId } from '@propr/core';
import {
  generateRepoImprovements, validateImprovementsRequest, ImprovementsOutputError, VALID_CATEGORIES,
  type ImprovementCategory, type RepoImprovementsRequest,
} from '../services/repoImprovements.js';
import { McpError } from './config.js';
import { redact } from './adapter.js';
import { classifyError, type McpErrorEnvelope } from './errorEnvelope.js';
import { McpOperations, type Operation } from './operations.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, idSchema } from './tools.js';

export const IMPROVEMENTS_TOOL = 'generate_repository_improvements';
/** Longest a generation may stay unsettled before its receipt is reported as interrupted. */
export const IMPROVEMENTS_TIMEOUT_MS = 30 * 60_000;
export const IMPROVEMENTS_OUTCOME_UNAVAILABLE = 'IMPROVEMENTS_OUTCOME_UNAVAILABLE';

export interface RepoImprovementsToolServices {
  /** Defaults to the HTTP route's generator, so context, model resolution and validation stay shared. */
  generate?: typeof generateRepoImprovements;
  /** Defaults to running after the receipt is returned; tests may await the job instead. */
  schedule?: (job: () => Promise<void>) => void;
}

/** Built on registration: tools.js shapes are not initialized while this module first evaluates. */
function improvementsSchema() {
  const categorySchema = z.enum(VALID_CATEGORIES as [ImprovementCategory, ...ImprovementCategory[]]);
  return z.object({
    ...mutationShape,
    repository: repositorySchema,
    branch: z.string().min(1).max(255).optional().describe('Branch to analyze. Omit for the repository default.'),
    categories: z.array(categorySchema).max(VALID_CATEGORIES.length).default([])
      .describe(`Focus areas: ${VALID_CATEGORIES.join(', ')}.`),
    customPrompt: z.string().max(65536).optional().describe('Free-text guidance for the suggestions.'),
    referenceRepository: repositorySchema.optional().describe('Indexed repository whose practices the suggestions may draw on.'),
    model: idSchema.optional().describe('Model from list_models. Omit for the configured planner context model.'),
    contextLevel: z.number().int().min(0).max(100).optional().describe('Share of the model context budget used for codebase summaries (default 50).'),
  }).strict().refine(args => args.categories.length > 0 || !!args.customPrompt?.trim(), {
    message: 'At least one category or a custom prompt is required', path: ['categories'],
  });
}

function outputFailure(error: ImprovementsOutputError): McpErrorEnvelope {
  return { code: error.code, message: error.message, stage: 'workflow', retryable: true, status: 500 };
}

/** Write the terminal receipt once; a concurrent terminal write keeps precedence. */
async function settle(deps: ToolDeps, id: string, outcome: { state: 'completed' | 'failed'; data: Record<string, unknown>; failure?: McpErrorEnvelope }): Promise<void> {
  const { state, data, failure } = outcome;
  const operations = new McpOperations(deps.db);
  await deps.db('mcp_operations').where({ id }).whereNotIn('state', ['completed', 'failed', 'cancelled'])
    .update({ state, result: JSON.stringify(redact(data)), updated_at: Date.now() });
  await operations.finish(id, state, failure);
}

interface Generation {
  operationId: string; request: RepoImprovementsRequest; target: { owner: string; repoName: string }; receipt: Record<string, unknown>;
}

async function runGeneration(deps: ToolDeps, services: RepoImprovementsToolServices, { operationId, request, target, receipt }: Generation): Promise<void> {
  const operations = new McpOperations(deps.db);
  try {
    await operations.markStarted(operationId);
    const generate = services.generate ?? generateRepoImprovements;
    const result = await generate(request, { ...target, correlationId: generateCorrelationId() });
    await settle(deps, operationId, { state: 'completed', data: { ...receipt, ...result, state: 'completed' } });
  } catch (error) {
    const failure = error instanceof ImprovementsOutputError ? outputFailure(error) : classifyError(error, { sideEffectsPossible: false });
    try {
      await settle(deps, operationId, { state: 'failed', data: { ...receipt, state: 'failed', error: failure }, failure });
    } catch (settleError) {
      console.error('[mcp] Failed to record repository improvements outcome:', { operationId, error: (settleError as Error).message });
    }
  }
}

/**
 * Generation runs in this process. A receipt that outlived the generation
 * bound lost its runner (for example to a restart) and is reported as such
 * instead of polling forever.
 */
export async function expireStaleImprovements(operations: McpOperations, row: Operation, now = Date.now()): Promise<boolean> {
  if (row.tool !== IMPROVEMENTS_TOOL || ['completed', 'failed', 'cancelled'].includes(row.lifecycle)) return false;
  if (now - Number(row.accepted_at) <= IMPROVEMENTS_TIMEOUT_MS) return false;
  await operations.markOutcomeUnavailable(row.id, {
    code: IMPROVEMENTS_OUTCOME_UNAVAILABLE, stage: 'workflow', retryable: true, status: 500,
    message: 'Improvement generation did not finish; it may have been interrupted. Start a new generation with a new idempotencyKey.',
  });
  return true;
}

export function addImprovementTools(tools: McpTool[], deps: ToolDeps): void {
  const services = deps.repoImprovements ?? {};
  tools.push({ name: IMPROVEMENTS_TOOL, description: 'Propose improvement ideas for a repository (the web UI Improve tab): feature ideas, security checks, tech debt and more. Returns an accepted receipt immediately; poll get_operation until completed, then read result.suggestions ({ title, description }) and timing metadata. Nothing is created in GitHub.', scope: 'plan',
    schema: improvementsSchema(), run: async ({ principal, args, operationId }) => {
      if (args.referenceRepository) await deps.policy.repository(principal, args.referenceRepository);
      const request: RepoImprovementsRequest = {
        repository: args.repository, branch: args.branch, categories: args.categories, customPrompt: args.customPrompt,
        referenceRepoId: args.referenceRepository ?? null, model: args.model, contextLevel: args.contextLevel,
      };
      const validation = validateImprovementsRequest(request);
      if (!validation.valid) throw new McpError('INVALID_INPUT', validation.error || 'Invalid improvements request.');
      if (!operationId) throw new McpError('INTERNAL_ERROR', 'Improvement generation requires a durable operation.', 500);
      const receipt = {
        repository: args.repository, branch: args.branch ?? null, categories: args.categories,
        referenceRepository: args.referenceRepository ?? null, model: args.model ?? null, contextLevel: args.contextLevel ?? 50,
      };
      const job = () => runGeneration(deps, services, {
        operationId, request, target: { owner: validation.owner!, repoName: validation.repoName! }, receipt,
      });
      (services.schedule ?? (run => { setImmediate(() => { void run(); }); }))(job);
      return { status: 202, data: { ...receipt, state: 'accepted', retrieveWith: 'get_operation' } };
    } });
}
