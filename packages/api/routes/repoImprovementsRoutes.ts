import { Request, Response } from 'express';
import { generateCorrelationId } from '@propr/core';
import {
  generateRepoImprovements,
  validateImprovementsRequest,
  ImprovementsOutputError,
  type RepoImprovementsRequest
} from '../services/repoImprovements.js';

export function createRepoImprovementsRoutes() {
  async function postImprovements(req: Request, res: Response): Promise<void> {
    const correlationId = generateCorrelationId();

    try {
      const body = req.body as RepoImprovementsRequest;
      const { repository, branch, categories, customPrompt, referenceRepoId } = body;

      // Validate request
      const validation = validateImprovementsRequest(body);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const { owner, repoName } = validation as { owner: string; repoName: string };

      console.log('[repo-improvements] Request received:', {
        correlationId,
        repository,
        branch: branch || 'default',
        categories,
        customPrompt: customPrompt ? `${customPrompt.substring(0, 50)}...` : undefined,
        referenceRepoId: referenceRepoId || null
      });

      // Return success response with suggestions
      res.json(await generateRepoImprovements(body, { owner, repoName, correlationId }));
    } catch (error) {
      if (error instanceof ImprovementsOutputError) {
        res.status(500).json({ error: error.message });
        return;
      }
      console.error('Error in /api/repos/improvements:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    }
  }

  return {
    postImprovements
  };
}
