import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

export interface UsageMetricRecordEntry {
  agent: string;
  metricKey: string;
  metricValue: number;
}

export interface LlmLogEntry {
  logId: number;
  executionType: string;
  modelName: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  success: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  sessionId: string | null;
  correlationId: string | null;
  draftId: string | null;
  repository: string | null;
  agentAlias: string | null;
  metadata: Record<string, unknown> | null;
  usageMetrics: Record<string, unknown> | null;
  usageMetricRecords: UsageMetricRecordEntry[];
  workType: 'task' | 'plan' | 'repository' | null;
  taskId: string | null;
  taskNumber: number | null;
  prNumber: number | null;
  planDraftId: string | null;
  planIssueId: number | null;
  workRepository: string | null;
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
  draft_id?: string;
  agent_alias?: string;
  work_type?: string;
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
  if (params.draft_id) {
    queryParams.append('draft_id', params.draft_id);
  }
  if (params.agent_alias) {
    queryParams.append('agent_alias', params.agent_alias);
  }
  if (params.work_type) {
    queryParams.append('work_type', params.work_type);
  }

  const queryString = queryParams.toString();
  const url = `${API_BASE_URL}/api/llm-logs${queryString ? `?${queryString}` : ''}`;

  const response = await apiFetch(url, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};
