/**
 * Repository-related HTTP handlers.
 */

import { Request, Response } from 'express';
import type { OwnershipResult, ValidateContextRepositoryResponse } from '../types.js';
import { getRepoAuthToken } from '../auth.js';

interface RepositoryInfoDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
}

export function createGetRepositoryInfoHandler(deps: RepositoryInfoDeps) {
  return async function getRepositoryInfo(req: Request, res: Response): Promise<void> {
    // draftId comes from URL path parameter for GET requests
    const draftId = req.params.id;
    const repository = req.query.repository as string | undefined;
    if (!draftId && !repository) {
      res.status(400).json({ error: 'Either draftId or repository is required' });
      return;
    }

    try {
      let repoFullName = repository;

      // If draftId provided, get repository from draft
      if (draftId) {
        const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository']);
        if (!ownership.authorized) {
          res.status(ownership.status!).json({ error: ownership.error });
          return;
        }
        repoFullName = ownership.draft?.repository as string | undefined;
      }

      if (!repoFullName) {
        res.status(400).json({ error: 'Repository not found' });
        return;
      }

      const [owner, repoName] = (repoFullName as string).split('/');
      if (!owner || !repoName) {
        res.status(400).json({ error: 'Invalid repository format' });
        return;
      }

      const accessToken = req.user?.accessToken;
      if (!accessToken) {
        res.status(401).json({ error: 'GitHub access token not available' });
        return;
      }

      const authToken = await getRepoAuthToken(accessToken);
      const { Octokit } = await import('@octokit/core');
      const octokit = new Octokit({ auth: authToken });

      // Fetch repo info first
      const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repoName });

      // Paginate through all branches
      const allBranches: string[] = [];
      let page = 1;
      while (true) {
        const branchesResponse = await octokit.request('GET /repos/{owner}/{repo}/branches', {
          owner,
          repo: repoName,
          per_page: 100,
          page
        });
        allBranches.push(...branchesResponse.data.map(b => b.name));
        if (branchesResponse.data.length < 100) break;
        page++;
      }

      res.json({
        repository: repoFullName,
        defaultBranch: repoInfo.data.default_branch,
        branches: allBranches,
        isPrivate: repoInfo.data.private,
        description: repoInfo.data.description
      });
    } catch (error) {
      console.error('Get repository info error:', error);
      res.status(500).json({ error: 'Failed to get repository info' });
    }
  };
}

/**
 * Create handler for validating context repositories
 */
export function createValidateContextRepositoryHandler() {
  return async function validateContextRepository(req: Request, res: Response): Promise<void> {
    const { repository, branch } = req.body;

    if (!repository || typeof repository !== 'string') {
      res.status(400).json({ valid: false, error: 'Repository is required (format: owner/repo)' });
      return;
    }

    const [owner, repoName] = repository.split('/');
    if (!owner || !repoName) {
      res.status(400).json({ valid: false, error: 'Invalid repository format. Expected: owner/repo' });
      return;
    }

    const accessToken = req.user?.accessToken;
    if (!accessToken) {
      res.status(401).json({ valid: false, error: 'GitHub access token not available' });
      return;
    }

    try {
      const authToken = await getRepoAuthToken(accessToken);
      const { Octokit } = await import('@octokit/core');
      const octokit = new Octokit({ auth: authToken });

      // Check if the repository exists and is accessible
      const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', {
        owner,
        repo: repoName
      });

      // Verify the branch exists if specified
      if (branch) {
        try {
          await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
            owner,
            repo: repoName,
            branch
          });
        } catch {
          res.status(400).json({
            valid: false,
            repository,
            error: `Branch '${branch}' not found in repository`
          });
          return;
        }
      }

      const response: ValidateContextRepositoryResponse = {
        valid: true,
        repository,
        defaultBranch: repoInfo.data.default_branch,
        description: repoInfo.data.description || undefined
      };

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check for specific GitHub API errors
      if (errorMessage.includes('Not Found')) {
        res.status(404).json({
          valid: false,
          repository,
          error: 'Repository not found or not accessible'
        });
        return;
      }

      res.status(500).json({
        valid: false,
        repository,
        error: `Failed to validate repository: ${errorMessage}`
      });
    }
  };
}
