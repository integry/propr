// Repository Indexing Status
import { API_BASE_URL, handleApiResponse } from './gitfixApi';

export interface RepositoryIndexingProgress {
  totalFiles: number;
  processedFiles: number;
  percentComplete: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RepositoryIndexingStatus {
  full_name: string;
  indexing_status: 'idle' | 'indexing' | 'completed' | 'failed';
  last_indexed_at: string | null;
  progress?: RepositoryIndexingProgress;
}

export const getRepositoriesIndexingStatus = async (): Promise<{ repositories: RepositoryIndexingStatus[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/indexing-status`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const stopRepositoryIndexing = async (repository: string): Promise<{ success: boolean }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/stop-indexing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const triggerRepositoryIndexing = async (repository: string): Promise<{ success: boolean; jobId?: string }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/trigger-indexing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, fullReindex: true }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
