// Repository Indexing Status
import { API_BASE_URL, handleApiResponse } from './gitfixApi';

export interface RepositoryIndexingStatus {
  full_name: string;
  indexing_status: 'idle' | 'indexing' | 'completed' | 'failed';
  last_indexed_at: string | null;
}

export const getRepositoriesIndexingStatus = async (): Promise<{ repositories: RepositoryIndexingStatus[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/config/repos/indexing-status`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
