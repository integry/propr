import { API_BASE_URL, handleApiResponse } from './gitfixApi';

export interface LlmLogEntry {
  executionId: number;
  taskId: string;
  sessionId: string | null;
  conversationId: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  modelName: string | null;
  success: boolean;
  numTurns: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  executionType: string;
}

export interface LlmLogsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface LlmLogsResponse {
  logs: LlmLogEntry[];
  pagination: LlmLogsPagination;
}

export interface LlmLogsParams {
  page?: number;
  limit?: number;
  execution_type?: string;
  model?: string;
  success?: boolean;
  task_id?: string;
}

export const getLlmLogs = async (params: LlmLogsParams = {}): Promise<LlmLogsResponse> => {
  const queryParams = new URLSearchParams();

  if (params.page !== undefined) {
    queryParams.append('page', params.page.toString());
  }
  if (params.limit !== undefined) {
    queryParams.append('limit', params.limit.toString());
  }
  if (params.execution_type) {
    queryParams.append('execution_type', params.execution_type);
  }
  if (params.model) {
    queryParams.append('model', params.model);
  }
  if (params.success !== undefined) {
    queryParams.append('success', params.success.toString());
  }
  if (params.task_id) {
    queryParams.append('task_id', params.task_id);
  }

  const queryString = queryParams.toString();
  const url = `${API_BASE_URL}/api/llm-logs${queryString ? `?${queryString}` : ''}`;

  const response = await fetch(url, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};
