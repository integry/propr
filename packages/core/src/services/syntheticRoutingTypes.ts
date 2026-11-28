import type { Knex } from 'knex';
import type { SyntheticAgentConfig } from '@propr/shared';
import type { Agent } from '../agents/types.js';

export interface SyntheticUsageSnapshot {
  directAgentAlias: string;
  capturedAt: Date;
  sessionPercent?: number;
  weeklyPercent?: number;
  /** When the session window resets, from the countdown Agent Tank reported at `capturedAt`. */
  sessionResetsAt?: Date;
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
  /**
   * A member chosen by an earlier capacity pre-check (possibly before a job
   * deferral). The first selection reuses it without advancing the round-robin
   * cursor while it stays eligible.
   */
  pinnedMemberId?: string;
  /**
   * Selection for a deferrable job: when no member of the chosen priority tier
   * (or the direct agent) has room under its per-agent ceiling, throw
   * AgentCapacityError instead of picking one that will wait at admission.
   */
  deferOnCapacity?: boolean;
}

export interface SyntheticRoutingServiceOptions {
  database?: Knex;
  loadSyntheticConfigs?: () => Promise<SyntheticAgentConfig[]>;
  getDirectAgent: (alias: string) => Agent | undefined;
  usageSnapshotProvider?: SyntheticUsageSnapshotProvider;
  now?: () => Date;
  /** Whether a direct agent alias has room under its per-agent ceiling (advisory). */
  aliasCapacity?: (directAgentAlias: string) => Promise<boolean>;
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

  /**
   * Total provider-reported cost of the physical attempts that ran in the
   * analyze call this error ended. Set only when at least one attempt ran and
   * every attempt reported a valid cost; otherwise the spend is unknown.
   */
  providerCostUsd?: number;
  /** Physical attempts that ran in the analyze call this error ended; 0 means nothing was spent. */
  analysisAttempts?: number;
}

/** A capacity wait never consumes a member: no failover, no failed attempt. */
function isCapacityWait(names: Array<string | undefined>, texts: unknown[]): boolean {
  if (names.some(name => name === 'AgentCapacityError' || name === 'AgentCapacityWaitTimeoutError')) return true;
  return texts.some(text => typeof text === 'string' && /waiting for agent capacity/i.test(text));
}

/** A returned or thrown failure that only waited for agent capacity; it reached no provider. */
export function isCapacityWaitFailure(failure: unknown): boolean {
  const value = failure as { name?: string; errorName?: string; message?: string; error?: string } | null;
  return !!value && isCapacityWait([value.name, value.errorName], [value.message, value.error]);
}

/**
 * What one physical analyze attempt adds to its call's total. A failed result
 * that only waited for capacity reached no provider: it costs nothing and is
 * not a spent attempt.
 */
export function analysisAttemptCost(result: { success: boolean; providerCostUsd?: number; error?: string }): { spent: boolean; providerCostUsd: number | undefined } {
  if (!result.success && result.providerCostUsd === undefined && isCapacityWaitFailure(result)) return { spent: false, providerCostUsd: 0 };
  return { spent: true, providerCostUsd: result.providerCostUsd };
}

/** Adds a valid cost to a known total; an unknown total or an invalid cost leaves the total unknown. */
export function addKnownCost(total: number | undefined, cost: number | undefined): number | undefined {
  return total !== undefined && cost !== undefined && Number.isFinite(cost) && cost >= 0 ? total + cost : undefined;
}

/**
 * What the analyze call ended by an error had already spent. Route exhaustion
 * and capacity waits both end a call without adding spend of their own, so
 * they carry the attempts that ran before them.
 */
interface AnalysisSpendCarrier {
  /** Physical attempts that reached a provider in the ended analyze call; 0 means nothing was spent. */
  analysisAttempts?: number;
  /** Their total, set only when at least one ran and each reported a valid cost. */
  providerCostUsd?: number;
}

function analysisSpendCarrier(error: unknown): AnalysisSpendCarrier | undefined {
  if (error instanceof SyntheticPoolExhaustedError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AgentCapacityError' || name === 'AgentCapacityWaitTimeoutError' ? error as AnalysisSpendCarrier : undefined;
}

/** Record on a route-exhaustion or capacity-wait error what the analyze call it ended had already spent. */
export function withAnalysisSpend(error: unknown, attempts: number, providerCostUsd: number | undefined): unknown {
  const carrier = analysisSpendCarrier(error);
  if (carrier) {
    carrier.analysisAttempts = attempts;
    if (attempts > 0) carrier.providerCostUsd = providerCostUsd;
  }
  return error;
}

/** Whether the error ended an analyze call in which no physical attempt reached a provider. */
export function endedAnalysisWithoutSpend(error: unknown): boolean {
  const carrier = analysisSpendCarrier(error);
  if (!carrier) return false;
  // A capacity wait raised outside a routing session has no attempts behind it.
  return carrier.analysisAttempts === 0 || (carrier.analysisAttempts === undefined && !(error instanceof SyntheticPoolExhaustedError));
}

/** The known spend carried by a route-exhaustion or capacity-wait error, if any. */
export function exhaustedRouteProviderCost(error: unknown): number | undefined {
  const carrier = analysisSpendCarrier(error);
  if (!carrier || !carrier.analysisAttempts) return undefined;
  const cost = carrier.providerCostUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
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
  if (isCapacityWait(names, [value?.message, value?.error])) return true;
  if (names.some(name => name && ['AgentAdmissionNestingError', 'ExecutionAbortedError', 'IndexingCancelledError', 'SecurityException', 'ContextTokenLimitError'].includes(name))) return true;
  if (codes.some(code => code && ['SECURITY_POLICY_VIOLATION', 'INVALID_CONFIGURATION', 'PROMPT_TOO_LARGE'].includes(code))) return true;
  if (terminationReason && ['user_cancelled', 'user_canceled'].includes(terminationReason)) return true;
  const explicitCancellation = /\btask\s+(?:was\s+)?(?:aborted|cancelled|canceled)\b|\b(?:execution|request|operation|call)\s+(?:was\s+)?(?:aborted|cancelled|canceled)\s+by\s+(?:the\s+)?(?:user|operator)\b|\b(?:aborted|cancelled|canceled)\s+by\s+(?:the\s+)?(?:user|operator)\b|\b(?:user|operator)\s+(?:requested\s+)?(?:aborted|cancelled|canceled|cancell?ation)\b|\b(?:user|task)[-_\s]+cancell?ation\b|\bcancell?ation\s+(?:was\s+)?requested\s+by\s+(?:the\s+)?(?:user|operator)\b/i;
  if (explicitCancellation.test(message)) return true;
  return /nested agent execution refused|security[- ]policy|security violation|invalid (?:user )?configuration|prompt (?:is )?too (?:large|long)|exceeds (?:the )?(?:model )?context window|context token limit/i.test(message);
}
