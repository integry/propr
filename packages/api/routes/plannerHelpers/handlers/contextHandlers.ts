/**
 * Context-related HTTP handlers.
 */

import { Request, Response } from 'express';
import { Knex } from 'knex';
import { generateContextPreview, BranchNotFoundError, ensureRepoCloned, generateCorrelationId, loadSettings } from '@propr/core';
import type { Granularity } from '@propr/core';
import type { OwnershipResult } from '../types.js';
import { getRepoAuthToken } from '../auth.js';

interface PreviewContextDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
  validateInput: (body: Record<string, unknown>) => { valid: boolean; error?: string };
  db?: Knex;
}

export function createPreviewContextHandler(deps: PreviewContextDeps) {
  return async function previewContext(req: Request, res: Response): Promise<void> {
    const validation = deps.validateInput(req.body);
    if (!validation.valid) { res.status(400).json({ error: validation.error }); return; }

    const { draftId, prompt, baseBranch, granularity, contextLevel, compress, files, contextRepositories, generationModel: requestGenerationModel } = req.body;
    const correlationId = generateCorrelationId();

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const draft = ownership.draft!;
      const [owner, repoName] = (draft.repository as string).split('/');
      if (!owner || !repoName) { res.status(400).json({ error: 'Invalid repository format' }); return; }

      const accessToken = req.user?.accessToken;
      if (!accessToken) { res.status(401).json({ error: 'GitHub access token not available' }); return; }

      const authToken = await getRepoAuthToken(accessToken);
      const worktreePath = await ensureRepoCloned({ repoUrl: `https://github.com/${owner}/${repoName}.git`, owner, repoName, authToken });

      // Load settings to get the configured context model for semantic scoring and generation model for limits
      const settings = await loadSettings();
      const contextModel = settings.planner_context_model;
      // Use request's generationModel if provided, otherwise use global setting
      const generationModel = requestGenerationModel || settings.planner_generation_model;

      // Store context repositories and generationModel in draft config if provided
      const hasConfigUpdates = contextRepositories || requestGenerationModel;
      if (deps.db && hasConfigUpdates) {
        const existingConfig = (draft.context_config as Record<string, unknown>) || {};
        const updatedConfig = {
          ...existingConfig,
          baseBranch,
          granularity: granularity || 'balanced',
          contextLevel,
          compress,
          ...(contextRepositories && { contextRepositories }),
          ...(requestGenerationModel && { generationModel: requestGenerationModel })
        };
        await deps.db('task_drafts').where({ draft_id: draftId }).update({
          context_config: JSON.stringify(updatedConfig),
          updated_at: deps.db.fn.now()
        });
      }

      const result = await generateContextPreview({ draftId, prompt, baseBranch, granularity: (granularity || 'balanced') as Granularity, contextLevel, compress, files, worktreePath, correlationId, contextModel, generationModel, contextRepositories, githubToken: authToken });
      res.json(result);
    } catch (error) {
      console.error('Preview context error:', error);
      if (error instanceof BranchNotFoundError) { res.status(400).json({ error: error.message }); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to preview context' });
    }
  };
}

interface ContextStatsDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

export function createGetContextStatsHandler(deps: ContextStatsDeps) {
  return async function getContextStats(req: Request, res: Response): Promise<void> {
    const { draftId, level } = req.body;
    if (!draftId) { res.status(400).json({ error: 'draftId is required' }); return; }

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const levelMultipliers: Record<string, number> = { low: 1, medium: 3, high: 10 };
      const multiplier = levelMultipliers[level] || levelMultipliers.medium;
      const baseTokens = 5000;
      const tokenCount = baseTokens * multiplier;
      const costEstimate = (tokenCount / 1_000_000) * 3;
      const smartFiles = level === 'low' ? 0 : level === 'medium' ? 15 : 50;

      res.json({ tokenCount, costEstimate, smartFiles });
    } catch (error) {
      console.error('Get context stats error:', error);
      res.status(500).json({ error: 'Failed to get context stats' });
    }
  };
}

interface DownloadContextDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
}

export function createDownloadContextHandler(deps: DownloadContextDeps) {
  return async function downloadContext(req: Request, res: Response): Promise<void> {
    const { draftId } = req.params;
    if (!draftId) {
      res.status(400).json({ error: 'draftId is required' });
      return;
    }

    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'generated_context']);
      if (!ownership.authorized) {
        res.status(ownership.status!).json({ error: ownership.error });
        return;
      }

      const generatedContext = ownership.draft?.generated_context;
      if (!generatedContext) {
        res.status(400).json({ error: 'No context has been generated yet. Please preview the context first.' });
        return;
      }

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="context-${draftId}.xml"`);
      res.send(generatedContext);

    } catch (error) {
      console.error('Download context error:', error);
      res.status(500).json({ error: 'Failed to download context' });
    }
  };
}
