/**
 * Usage configuration and metrics types for agent resource management.
 *
 * UsageMetrics captures pre-call, post-call, and delta values to track
 * how much allowance each LLM call consumed. Supports nested generic
 * properties since providers have varying usage structures.
 */

import type { AgentType } from './modelDefinitions.js';

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
 * A single structured usage metric record for DB storage and querying.
 *
 * Each LLM call produces multiple records — one per metric key
 * (e.g. "session" and "weeklyAll" for Claude). This flat structure
 * enables easy DB querying and report generation.
 */
export interface UsageMetricRecord {
  /** The agent name (e.g. "claude", "antigravity", "codex"). */
  agent: string;
  /** The metric key (e.g. "session", "weeklyAll", "fiveHour"). */
  metricKey: string;
  /** The percentage-point delta consumed by this call. */
  metricValue: number;
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
  /** Structured per-metric records for DB storage */
  records?: UsageMetricRecord[];
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
