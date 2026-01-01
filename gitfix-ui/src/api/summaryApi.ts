// Summary Browser API - File and Directory Summaries
import { API_BASE_URL, handleApiResponse } from './gitfixApi';

// ============= Types =============

export interface SummaryEntry {
  name: string;
  path: string;
  entryType: 'file' | 'directory';
  summary: string | null;
  hasChildren?: boolean;
}

export interface DirectoryTreeResponse {
  repository: string;
  path: string;
  entries: SummaryEntry[];
}

export interface PathSummaryResponse {
  repository: string;
  path: string;
  entryType: 'file' | 'directory';
  summary: string | null;
}

export interface IndexingStatusResponse {
  repository: string;
  indexed: boolean;
  indexingStatus: 'idle' | 'indexing' | 'completed' | 'failed';
  totalEntries: number;
  fileCount: number;
  directoryCount: number;
  lastIndexedAt: string | null;
}

// ============= API Functions =============

/**
 * Fetch the directory tree for a repository at a specific path.
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param path - Optional path within the repository (defaults to root)
 * @returns Directory tree with entries and their summaries
 */
export async function getDirectoryTree(
  owner: string,
  repo: string,
  path: string = ''
): Promise<DirectoryTreeResponse> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const pathSuffix = path ? `/${encodeURIComponent(path)}` : '';
  const url = `${API_BASE_URL}/api/summaries/${encodedOwner}/${encodedRepo}/tree${pathSuffix}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  await handleApiResponse(response);
  return response.json();
}

/**
 * Fetch the summary for a specific file or directory path.
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param path - Path to the file or directory
 * @returns Summary information for the path
 */
export async function getPathSummary(
  owner: string,
  repo: string,
  path: string
): Promise<PathSummaryResponse> {
  if (!path) {
    throw new Error('Path is required to fetch summary');
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = encodeURIComponent(path);
  const url = `${API_BASE_URL}/api/summaries/${encodedOwner}/${encodedRepo}/summary/${encodedPath}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  await handleApiResponse(response);
  return response.json();
}

/**
 * Check the indexing status for a repository.
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns Indexing status including file/directory counts
 */
export async function getIndexingStatus(
  owner: string,
  repo: string
): Promise<IndexingStatusResponse> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const url = `${API_BASE_URL}/api/summaries/${encodedOwner}/${encodedRepo}/status`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  await handleApiResponse(response);
  return response.json();
}

/**
 * Fetch the full tree structure recursively (for small repositories).
 * This fetches all levels at once - use with caution on large repos.
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param maxDepth - Maximum depth to fetch (default: 3)
 * @returns Flat array of all entries up to maxDepth
 */
export async function getFullTree(
  owner: string,
  repo: string,
  maxDepth: number = 3
): Promise<SummaryEntry[]> {
  const allEntries: SummaryEntry[] = [];

  async function fetchLevel(path: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    const tree = await getDirectoryTree(owner, repo, path);

    for (const entry of tree.entries) {
      allEntries.push(entry);

      if (entry.entryType === 'directory' && entry.hasChildren) {
        await fetchLevel(entry.path, depth + 1);
      }
    }
  }

  await fetchLevel('', 0);
  return allEntries;
}
