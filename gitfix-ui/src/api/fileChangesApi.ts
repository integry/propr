import { API_BASE_URL, handleApiResponse } from './gitfixApi';

/**
 * Represents a single file change in the worktree
 */
export interface FileChange {
  /** Relative path from worktree root */
  path: string;
  /** Number of lines added */
  linesAdded: number;
  /** Number of lines removed */
  linesRemoved: number;
  /** Unified diff content for this file */
  diff: string;
  /** File status: 'modified', 'added', 'deleted', 'renamed' */
  status: 'modified' | 'added' | 'deleted' | 'renamed';
}

/**
 * Response from the file changes API
 */
export interface FileChangesResponse {
  /** Array of file changes */
  files: FileChange[];
  /** Timestamp of when this data was last updated */
  lastUpdated: string;
  /** Total lines added across all files */
  totalLinesAdded: number;
  /** Total lines removed across all files */
  totalLinesRemoved: number;
  /** Whether the task is still active */
  isActive: boolean;
}

/**
 * Fetches file changes for a specific task
 * @param taskId The task ID to fetch file changes for
 * @returns Promise resolving to file changes response
 */
export const getFileChanges = async (taskId: string): Promise<FileChangesResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/file-changes`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
