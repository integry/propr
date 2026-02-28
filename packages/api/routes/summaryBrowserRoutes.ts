import { Request, Response } from 'express';
import { db } from '@propr/core';

interface SummaryEntry {
  name: string;
  path: string;
  entryType: 'file' | 'directory';
  summary: string | null;
  hasChildren?: boolean;
}

interface TreeResponse {
  repository: string;
  path: string;
  entries: SummaryEntry[];
}

interface SummaryResponse {
  repository: string;
  path: string;
  entryType: 'file' | 'directory';
  summary: string | null;
}

/**
 * Extract repository prefix from a file path.
 * Paths are stored as "owner/repo/path/to/file" in the database.
 */
function getRepositoryPrefix(owner: string, repo: string): string {
  return `${owner}/${repo}/`;
}

/**
 * Get immediate children of a directory path in the repository.
 * Returns directory tree entries with their summaries.
 */
async function getDirectoryTree(req: Request, res: Response): Promise<void> {
  const { owner, repo } = req.params;
  const pathParam = req.params[0] || ''; // Catch-all for nested paths
  const repository = `${owner}/${repo}`;
  const basePath = pathParam ? pathParam.replace(/^\/+|\/+$/g, '') : '';
  const repoPrefix = getRepositoryPrefix(owner, repo);
  // Get branch from query parameter or default to HEAD
  const branch = (req.query.branch as string) || 'HEAD';

  try {
    // Check if repository has been indexed for this branch
    const repoRecord = await db('repositories')
      .where({ full_name: repository, branch })
      .first();

    if (!repoRecord) {
      res.status(404).json({
        error: 'Repository not indexed',
        message: `No summaries found for repository ${repository} on branch ${branch}. The repository may not have been indexed yet.`
      });
      return;
    }

    // Build the full path prefix for database queries
    const fullBasePath = basePath === '' ? repoPrefix.slice(0, -1) : `${repoPrefix}${basePath}`;

    // Query file summaries that are direct children of the current path (filtered by branch)
    const fileQuery = db('file_summaries')
      .select('path', 'summary')
      .where('path', 'LIKE', `${fullBasePath}/%`)
      .whereRaw(`path NOT LIKE ?`, [`${fullBasePath}/%/%`])
      .andWhere({ branch });

    // Query directory summaries that are direct children of the current path (filtered by branch)
    const dirQuery = db('directory_summaries')
      .select('path', 'summary')
      .where('path', 'LIKE', `${fullBasePath}/%`)
      .whereRaw(`path NOT LIKE ?`, [`${fullBasePath}/%/%`])
      .andWhere({ branch });

    const [files, directories] = await Promise.all([fileQuery, dirQuery]);

    // Transform results
    const entries: SummaryEntry[] = [];

    // Add directories first (sorted)
    for (const dir of directories) {
      const fullPath = dir.path as string;
      const relativePath = fullPath.slice(repoPrefix.length);
      const name = basePath === '' ? relativePath : relativePath.slice(basePath.length + 1);

      entries.push({
        name,
        path: relativePath,
        entryType: 'directory',
        summary: dir.summary as string | null,
        hasChildren: true
      });
    }

    // Add files (sorted)
    for (const file of files) {
      const fullPath = file.path as string;
      const relativePath = fullPath.slice(repoPrefix.length);
      const name = basePath === '' ? relativePath : relativePath.slice(basePath.length + 1);

      entries.push({
        name,
        path: relativePath,
        entryType: 'file',
        summary: file.summary as string | null,
        hasChildren: false
      });
    }

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.entryType !== b.entryType) {
        return a.entryType === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const response: TreeResponse = {
      repository,
      path: basePath || '/',
      entries
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching directory tree:', error);
    res.status(500).json({ error: 'Failed to fetch directory tree' });
  }
}

/**
 * Get summary for a specific file or directory path.
 */
async function getPathSummary(req: Request, res: Response): Promise<void> {
  const { owner, repo } = req.params;
  const pathParam = req.params[0] || '';
  const repository = `${owner}/${repo}`;
  const filePath = pathParam.replace(/^\/+|\/+$/g, '');
  const repoPrefix = getRepositoryPrefix(owner, repo);
  // Get branch from query parameter or default to HEAD
  const branch = (req.query.branch as string) || 'HEAD';

  if (!filePath) {
    res.status(400).json({ error: 'Path is required' });
    return;
  }

  const fullPath = `${repoPrefix}${filePath}`;

  try {
    // Check file_summaries first (filtered by branch)
    const fileEntry = await db('file_summaries')
      .select('path', 'summary')
      .where({ path: fullPath, branch })
      .first();

    if (fileEntry) {
      const response: SummaryResponse = {
        repository,
        path: filePath,
        entryType: 'file',
        summary: fileEntry.summary as string | null
      };
      res.json(response);
      return;
    }

    // Check directory_summaries (filtered by branch)
    const dirEntry = await db('directory_summaries')
      .select('path', 'summary')
      .where({ path: fullPath, branch })
      .first();

    if (dirEntry) {
      const response: SummaryResponse = {
        repository,
        path: filePath,
        entryType: 'directory',
        summary: dirEntry.summary as string | null
      };
      res.json(response);
      return;
    }

    res.status(404).json({
      error: 'Path not found',
      message: `No summary found for path '${filePath}' in repository ${repository} on branch ${branch}`
    });
  } catch (error) {
    console.error('Error fetching path summary:', error);
    res.status(500).json({ error: 'Failed to fetch path summary' });
  }
}

/**
 * Get indexing status for a repository.
 */
async function getIndexingStatus(req: Request, res: Response): Promise<void> {
  const { owner, repo } = req.params;
  const repository = `${owner}/${repo}`;
  const repoPrefix = getRepositoryPrefix(owner, repo);
  // Get branch from query parameter or default to HEAD
  const branch = (req.query.branch as string) || 'HEAD';

  try {
    // Get repository record for the specific branch
    const repoRecord = await db('repositories')
      .where({ full_name: repository, branch })
      .first();

    if (!repoRecord) {
      res.json({
        repository,
        branch,
        indexed: false,
        indexingStatus: 'idle',
        totalEntries: 0,
        fileCount: 0,
        directoryCount: 0,
        lastIndexedAt: null,
        lastIndexedHash: null,
        lastIndexedCommitMessage: null
      });
      return;
    }

    // Count files and directories (filtered by branch)
    const [fileStats, dirStats] = await Promise.all([
      db('file_summaries')
        .where('path', 'LIKE', `${repoPrefix}%`)
        .andWhere({ branch })
        .count('* as count')
        .first(),
      db('directory_summaries')
        .where('path', 'LIKE', `${repoPrefix}%`)
        .andWhere({ branch })
        .count('* as count')
        .first()
    ]);

    const fileCount = parseInt(String(fileStats?.count || 0), 10);
    const directoryCount = parseInt(String(dirStats?.count || 0), 10);

    res.json({
      repository,
      branch,
      indexed: repoRecord.indexing_status === 'completed',
      indexingStatus: repoRecord.indexing_status,
      totalEntries: fileCount + directoryCount,
      fileCount,
      directoryCount,
      lastIndexedAt: repoRecord.last_indexed_at,
      lastIndexedHash: repoRecord.last_indexed_hash || null,
      lastIndexedCommitMessage: repoRecord.last_indexed_commit_message || null
    });
  } catch (error) {
    console.error('Error fetching indexing status:', error);
    res.status(500).json({ error: 'Failed to fetch indexing status' });
  }
}

export function createSummaryBrowserRoutes() {
  return {
    getDirectoryTree,
    getPathSummary,
    getIndexingStatus
  };
}
