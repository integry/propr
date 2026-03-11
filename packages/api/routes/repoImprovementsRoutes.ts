import { Request, Response } from 'express';

/**
 * Improvement categories available for repository analysis
 */
type ImprovementCategory =
  | 'code-quality'
  | 'performance'
  | 'security'
  | 'testing'
  | 'documentation'
  | 'architecture';

interface RepoImprovementsRequest {
  repository: string;
  branch?: string;
  categories: ImprovementCategory[];
  customPrompt?: string;
  referenceRepoId?: string | null;
}

export function createRepoImprovementsRoutes() {
  async function postImprovements(req: Request, res: Response): Promise<void> {
    try {
      const {
        repository,
        branch,
        categories,
        customPrompt,
        referenceRepoId
      } = req.body as RepoImprovementsRequest;

      // Validate required fields
      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required and must be a string' });
        return;
      }

      // Parse repository into owner and name
      const [owner, repoName] = repository.split('/');
      if (!owner || !repoName) {
        res.status(400).json({ error: 'Invalid repository format. Expected "owner/repo"' });
        return;
      }

      // Validate categories array
      if (!Array.isArray(categories)) {
        res.status(400).json({ error: 'categories must be an array' });
        return;
      }

      // Validate that at least one category is provided or customPrompt is present
      const hasCategories = categories.length > 0;
      const hasCustomPrompt = customPrompt && typeof customPrompt === 'string' && customPrompt.trim().length > 0;

      if (!hasCategories && !hasCustomPrompt) {
        res.status(400).json({ error: 'At least one category or a custom prompt is required' });
        return;
      }

      // Validate category values if provided
      const validCategories: ImprovementCategory[] = [
        'code-quality',
        'performance',
        'security',
        'testing',
        'documentation',
        'architecture'
      ];

      for (const category of categories) {
        if (!validCategories.includes(category)) {
          res.status(400).json({
            error: `Invalid category: ${category}. Valid categories are: ${validCategories.join(', ')}`
          });
          return;
        }
      }

      // Log the request parameters for debugging
      console.log('[repo-improvements] Request received:', {
        repository,
        branch: branch || 'default',
        categories,
        customPrompt: customPrompt ? `${customPrompt.substring(0, 50)}...` : undefined,
        referenceRepoId: referenceRepoId || null
      });

      // Return success response with parsed parameters
      // The actual LLM integration will be implemented in a future task
      res.json({
        success: true,
        message: 'Repository improvement request received',
        params: {
          owner,
          repoName,
          branch: branch || 'HEAD',
          categories,
          customPrompt: customPrompt || null,
          referenceRepoId: referenceRepoId || null
        }
      });
    } catch (error) {
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
