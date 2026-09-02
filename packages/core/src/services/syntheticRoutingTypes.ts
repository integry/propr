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
  /** Reject physical agents that cannot satisfy call-specific runtime constraints. */
  physicalAgentEligibility?: (agent: Agent) => boolean;
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
  const value = error as {
    name?: string;
    code?: string;
    message?: string;
    error?: string;
    errorName?: string;
    errorCode?: string;
    terminationReason?: string;
    logs?: string;
  };
  const names = [value?.name, value?.errorName];
  const codes = [value?.code, value?.errorCode];
  const terminationReason = typeof value?.terminationReason === 'string'
    ? value.terminationReason.trim().toLowerCase()
    : undefined;
  const message = [value?.message, value?.error, value?.logs]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('\n') || String(error || '');
  // Generic abort names/codes are also emitted for provider timeouts and
  // interrupted transports. Only explicit task-cancellation errors stop
  // failover; an unqualified AbortError/ABORT_ERR/ERR_CANCELED remains retryable.
  if (names.some(name => name && ['ExecutionAbortedError', 'IndexingCancelledError', 'SecurityException', 'ContextTokenLimitError'].includes(name))) return true;
  if (codes.some(code => code && ['SECURITY_POLICY_VIOLATION', 'INVALID_CONFIGURATION', 'PROMPT_TOO_LARGE'].includes(code))) return true;
  if (terminationReason && ['user_cancelled', 'user_canceled'].includes(terminationReason)) return true;
  const explicitCancellation = /\btask\s+(?:was\s+)?(?:aborted|cancelled|canceled)\b|\b(?:execution|request|operation|call)\s+(?:was\s+)?(?:aborted|cancelled|canceled)\s+by\s+(?:the\s+)?(?:user|operator)\b|\b(?:aborted|cancelled|canceled)\s+by\s+(?:the\s+)?(?:user|operator)\b|\b(?:user|operator)\s+(?:requested\s+)?(?:aborted|cancelled|canceled|cancell?ation)\b|\b(?:user|task)[-_\s]+cancell?ation\b|\bcancell?ation\s+(?:was\s+)?requested\s+by\s+(?:the\s+)?(?:user|operator)\b/i;
  if (explicitCancellation.test(message)) return true;
  return /security[- ]policy|security violation|invalid (?:user )?configuration|prompt (?:is )?too (?:large|long)|exceeds (?:the )?(?:model )?context window|context token limit/i.test(message);
}
