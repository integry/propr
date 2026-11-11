// API for fetching file changes during task execution
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export interface FileChange {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
}

/** Another active task on the same repository whose live changes touch the same files. */
export interface FileOverlap {
  taskId: string;
  /** Shared paths (a trailing `/` marks a shared hot directory), at most ten. */
  paths: string[];
  totalPaths: number;
  repository: string;
  issueNumber: number | null;
  taskType: string | null;
}

export interface FileChangesResponse {
  files: FileChange[];
  lastUpdated: string;
  taskId: string;
  /** Absent from servers that predate overlap detection. */
  overlaps?: FileOverlap[];
}

export const getFileChanges = async (taskId: string): Promise<FileChangesResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/file-changes`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
