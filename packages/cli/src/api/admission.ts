/**
 * Agent-run admission API
 *
 * Read-only report from `GET /api/agent-run-admission`: what admission
 * enforces globally and per agent, with the other limits a scheduler must
 * respect. Not subscription usage.
 */

import { ApiClient, createApiClient } from "./index.js";

export interface AdmissionStateCounts { reserved: number; running: number; draining: number; recovering: number; total: number }
export interface AdmissionWaitingCounts { total: number; globalLimit: number; agentCeiling: number; recovering: number; starting: number }

export interface AdmissionAgent {
  alias: string;
  ceiling: number | null;
  inUse: number;
  holders: AdmissionStateCounts;
  nested: { total: number; chargedUnderParent: number; countedAgainstCeiling: number };
  waiting: AdmissionWaitingCounts;
  deferred: number;
  tasks: Array<{ taskId: string; alias: string | null; state: string; waitReason?: string; nested: boolean; since?: string }>;
}

export interface AgentRunAdmissionReport {
  asOf: string;
  admission: {
    enabled: boolean;
    agentCeilingsConfigured: boolean;
    global: null | {
      limit: number;
      limitSource: string;
      generation: number;
      nestedLimit: number;
      nestedLimitSource: string;
      inUse: number;
      holders: AdmissionStateCounts;
      unattributedHolders: number;
      nested: { total: number; chargedUnderParent: number; countedAgainstOtherAgent: number };
      waiting: AdmissionWaitingCounts;
      deferred: number;
    };
    unavailable?: string;
  };
  agents: AdmissionAgent[];
  queueWorkers: { label: string; inUse: number | null; total: number | null; workers: number | null };
  repositoryWorkflowSlots: { label: string; repositories: Array<{ repository: string; inUse: number; limit: number; waiting: number }> };
  subscriptionUsage: string;
}

export async function getAgentRunAdmission(client?: ApiClient): Promise<AgentRunAdmissionReport> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<AgentRunAdmissionReport>("/api/agent-run-admission");
  return response.data;
}
