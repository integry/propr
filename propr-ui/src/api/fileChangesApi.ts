// API for fetching file changes during task execution
import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

export interface FileChange {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
}

export interface FileChangesResponse {
  files: FileChange[];
  lastUpdated: string;
  taskId: string;
}

export const getFileChanges = async (taskId: string): Promise<FileChangesResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/file-changes`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
