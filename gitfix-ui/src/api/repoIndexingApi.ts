// Repository Indexing Status
import { API_BASE_URL, handleApiResponse } from './gitfixApi';

export interface RepositoryIndexingProgress {
  totalFiles: number;
  processedFiles: number;
  percentComplete: number;
  inputTokens: number;
  outputTokens: number;
  phase: 'files' | 'directories' | 'done';
  totalDirectories: number;
  processedDirectories: number;
}

export interface RepositoryIndexingStatus {
  full_name: string;
  branch: string;
  indexing_status: 'idle' | 'indexing' | 'completed' | 'failed';
  last_indexed_at: string | null;
  progress?: RepositoryIndexingProgress;
}

// Helper to generate a unique key for a repository+branch combination
export const getRepoStatusKey = (fullName: string, branch?: string): string => {
  return branch && branch !== 'HEAD' ? `${fullName}:${branch}` : fullName;
};

export const getRepositoriesIndexingStatus = async (): Promise<{ repositories: RepositoryIndexingStatus[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/indexing-status`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const stopRepositoryIndexing = async (repository: string, branch?: string): Promise<{ success: boolean }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/stop-indexing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, branch }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const triggerRepositoryIndexing = async (repository: string, baseBranch?: string): Promise<{ success: boolean; jobId?: string }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/trigger-indexing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, baseBranch, fullReindex: true }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
