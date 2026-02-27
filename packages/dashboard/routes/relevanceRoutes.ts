import { Request, Response } from 'express';
import {
  findRelevantFiles,
  ensureRepoCloned,
  getGitHubInstallationToken,
  generateCorrelationId
} from '@propr/core';

export function createRelevanceRoutes() {
  async function analyzeRelevance(req: Request, res: Response): Promise<void> {
    const correlationId = generateCorrelationId();
    
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const { repository, prompt } = req.body;

      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'Repository is required' });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'Prompt is required' });
        return;
      }

      const repoMatch = repository.match(/^([^/]+)\/([^/]+)$/);
      if (!repoMatch) {
        res.status(400).json({ error: 'Invalid repository format. Expected: owner/repo' });
        return;
      }

      const [, owner, repoName] = repoMatch;
      const accessToken = req.user?.accessToken;

      if (!accessToken) {
        res.status(401).json({ error: 'GitHub access token not available' });
        return;
      }

      let authToken: string;
      try {
        authToken = await getGitHubInstallationToken();
      } catch {
        authToken = accessToken;
      }

      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      const repoPath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken });

      const result = await findRelevantFiles(repoPath, prompt, {
        correlationId,
        maxResults: 20,
        minScore: 30
      });

      res.json({
        files: result.files,
        keywordsDetected: result.keywordsDetected
      });
    } catch (error) {
      console.error('Relevance analysis error:', error);
      res.status(500).json({ error: 'Failed to analyze relevance' });
    }
  }

  return {
    analyzeRelevance
  };
}
