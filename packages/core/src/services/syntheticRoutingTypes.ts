import type { Knex } from 'knex';
import type { SyntheticAgentConfig } from '@propr/shared';
import type { Agent } from '../agents/types.js';

export interface SyntheticUsageSnapshot {
  directAgentAlias: string;
  capturedAt: Date;
  sessionPercent?: number;
  weeklyPercent?: number;
}

export interface SyntheticUsageSnapshotProvider {
  getSnapshot(directAgentAlias: string): Promise<SyntheticUsageSnapshot | null>;
}

export interface SyntheticMemberDiagnostic {
  memberId: string;
  directAgentAlias: string;
  model: string;
  eligible: boolean;
  reason: string;
}

export interface SyntheticPhysicalSelection {
  virtualAgentAlias: string;
  virtualModel: string;
  physicalAgent: Agent;
  physicalAgentAlias: string;
  physicalModel: string;
  memberId?: string;
  callId: string;
  attemptNumber: number;
  selectionReason: string;
  requiredTokens: number;
  diagnostics: SyntheticMemberDiagnostic[];
  synthetic: boolean;
}

export interface BeginSyntheticRoutingOptions {
  requestedAgentAlias: string;
  requestedModel?: string;
  /** Prompt plus output/runtime reserve. This constraint is immutable for retries. */
  requiredTokens?: number;
  promptTokens?: number;
  outputReserveTokens?: number;
  callId?: string;
}

export interface SyntheticRoutingServiceOptions {
  database?: Knex;
  loadSyntheticConfigs?: () => Promise<SyntheticAgentConfig[]>;
  getDirectAgent: (alias: string) => Agent | undefined;
  usageSnapshotProvider?: SyntheticUsageSnapshotProvider;
  now?: () => Date;
}

export class SyntheticPoolExhaustedError extends Error {
  constructor(
    public readonly virtualAgentAlias: string,
    public readonly virtualModel: string,
    public readonly callId: string,
    public readonly diagnostics: SyntheticMemberDiagnostic[],
  ) {
    const details = diagnostics.length === 0
      ? 'no configured members'
      : diagnostics.map(item => `${item.directAgentAlias}:${item.model} (${item.reason})`).join('; ');
    super(`Synthetic pool exhausted for '${virtualAgentAlias}:${virtualModel}' [call ${callId}]: ${details}`);
    this.name = 'SyntheticPoolExhaustedError';
  }
}

export function isNonRetryableSyntheticFailure(error: unknown): boolean {
  const value = error as { name?: string; code?: string; message?: string };
  const name = value?.name || '';
  const code = value?.code || '';
  const message = value?.message || String(error || '');
  if (['AbortError', 'ExecutionAbortedError', 'IndexingCancelledError', 'SecurityException', 'ContextTokenLimitError'].includes(name)) return true;
  if (['ABORT_ERR', 'ERR_CANCELED', 'SECURITY_POLICY_VIOLATION', 'INVALID_CONFIGURATION', 'PROMPT_TOO_LARGE'].includes(code)) return true;
  return /(?:aborted|cancelled|canceled) by (?:the )?user|security[- ]policy|security violation|invalid (?:user )?configuration|prompt (?:is )?too (?:large|long)|exceeds (?:the )?(?:model )?context window|context token limit/i.test(message);
}
