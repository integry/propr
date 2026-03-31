/**
 * Usage configuration and metrics types for agent resource management.
 *
 * AgentTankConfig defines the allowance/quota settings for an agent,
 * supporting subscription billing models where each agent has a "tank"
 * of available usage.
 *
 * UsageMetrics captures pre-call, post-call, and delta values to track
 * how much allowance each LLM call consumed. Supports nested generic
 * properties since providers have varying usage structures.
 */

import type { AgentType } from './modelDefinitions.js';

/** Configuration for an agent's usage allowance ("tank"). */
export interface AgentTankConfig {
  /** Agent type this config applies to */
  agentType: AgentType;
  /** Maximum allowed spend in USD per billing period */
  maxBudgetUsd: number;
  /** Billing period duration (e.g., 'daily', 'weekly', 'monthly') */
  billingPeriod: 'daily' | 'weekly' | 'monthly';
  /** Soft limit percentage (0-1) at which to trigger warnings */
  warningThreshold: number;
  /** Hard limit percentage (0-1) at which to block new requests */
  hardLimitThreshold: number;
  /** Whether this tank is currently active */
  enabled: boolean;
  /** Optional per-model budget overrides (model ID -> max USD) */
  modelBudgets?: Record<string, number>;
  /** Optional maximum number of requests per billing period */
  maxRequests?: number;
  /** Optional maximum number of tokens per billing period */
  maxTokens?: number;
  /** Additional provider-specific configuration */
  providerConfig?: Record<string, unknown>;
}

/**
 * Snapshot of usage values at a point in time.
 * Uses Record<string, unknown> for provider-specific nested properties,
 * since providers report usage in varying structures.
 */
export interface UsageSnapshot {
  /** Total tokens consumed */
  totalTokens?: number;
  /** Total cost in USD */
  costUsd?: number;
  /** Number of requests made */
  requestCount?: number;
  /** Provider-specific usage details (varies by provider) */
  providerDetails?: Record<string, unknown>;
}

/**
 * Tracks usage metrics for an LLM call, capturing state before and after
 * the call to compute the delta (consumption) for billing purposes.
 */
export interface UsageMetrics {
  /** Usage state before the LLM call */
  preCall: UsageSnapshot;
  /** Usage state after the LLM call */
  postCall: UsageSnapshot;
  /** Computed difference (what this call consumed) */
  delta: UsageSnapshot;
  /** ISO 8601 timestamp of when the metrics were captured */
  timestamp: string;
  /** Model ID used for this call */
  model?: string;
  /** Agent type that made the call */
  agentType?: AgentType;
  /** Correlation ID linking to the LLM log entry */
  correlationId?: string;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
}
