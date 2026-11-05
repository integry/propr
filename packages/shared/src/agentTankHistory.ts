/**
 * Agent Tank usage history, as served by `GET /api/config/agent-tank/history`.
 *
 * The series shape mirrors Agent Tank 0.10's `GET /history/:id` so the daemon's
 * own history can be passed through unchanged; ProPR's locally recorded history
 * (bundled mode, or a daemon without a history store) uses the same metric keys
 * (`session`, `weeklyAll`, `fiveHour`, `model:<Antigravity quota>`, ...).
 */

export interface AgentTankHistoryPoint {
  /** ISO 8601 capture time. */
  t: string;
  /** Percent of the window used, 0-100; null for non-percentage metrics. */
  percent: number | null;
}

export interface AgentTankHistorySeries {
  /** Stable series identity; a CLI relabel changes `label`, never `key`. */
  key: string;
  label: string;
  model: string | null;
  /** `session`, `five_hour`, `weekly`, `daily`, ... or null when not a window. */
  cycle: string | null;
  points: AgentTankHistoryPoint[];
}

export interface AgentTankHistoryAgent {
  /** ProPR-facing provider name (`claude`, `codex`, `antigravity`). */
  agent: string;
  series: AgentTankHistorySeries[];
}

/** Where a history answer came from. */
export type AgentTankHistorySource = 'agent-tank' | 'propr';

export interface AgentTankHistoryResponse {
  enabled: boolean;
  source?: AgentTankHistorySource;
  /** How far back history can reach, in days. */
  retentionDays?: number;
  agents: AgentTankHistoryAgent[];
  error?: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Length of one quota period per Agent Tank cycle. A Claude "session" and a
 * Codex "five_hour" window are both five hours; Antigravity's un-windowed
 * per-model quotas refresh daily.
 */
export const AGENT_TANK_CYCLE_DURATIONS_MS: Readonly<Record<string, number>> = Object.freeze({
  session: 5 * HOUR_MS,
  five_hour: 5 * HOUR_MS,
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
  monthly: 30 * 24 * HOUR_MS,
});

/** One period of the given cycle, defaulting to the five-hour session. */
export function agentTankCyclePeriodMs(cycle: string | null | undefined): number {
  return (cycle && AGENT_TANK_CYCLE_DURATIONS_MS[cycle]) || AGENT_TANK_CYCLE_DURATIONS_MS.session;
}

/** Recorded history is kept long enough to show two weekly periods. */
export const AGENT_TANK_HISTORY_RETENTION_DAYS = 15;
