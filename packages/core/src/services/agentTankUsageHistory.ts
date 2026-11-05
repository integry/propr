/**
 * ProPR's own record of Agent Tank usage over time.
 *
 * Bundled Agent Tank runs `--once` in a disposable container, so the history
 * database Agent Tank 0.10 keeps is thrown away after every run; an external
 * daemon may predate history or have it switched off. Every snapshot ProPR
 * observes is therefore also written here, one row per metric, and the usage
 * charts read whichever source actually has history (see `readUsageHistory` in
 * `agentTankService.ts`).
 *
 * Writes are deduplicated per series: a re-read of the same capture is never
 * stored twice, and an unchanged value is stored at most once per heartbeat so
 * a flat line stays anchored without filling the table with copies.
 */

import type { Knex } from 'knex';
import {
    AGENT_TANK_HISTORY_RETENTION_DAYS,
    type AgentTankHistoryAgent,
    type AgentTankHistorySeries,
} from '@propr/shared';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { extractAgentTankUsageMetrics } from './agentTankUsageMetrics.js';
import type { AgentStatusResponse } from './agentTankTypes.js';

const TABLE = 'agent_tank_usage_history';
const DAY_MS = 24 * 60 * 60 * 1000;
/** An unchanged value is re-recorded this often so its line stays anchored. */
const UNCHANGED_HEARTBEAT_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** A capture time this far in the future is a skewed clock, not a capture. */
const MAX_CLOCK_SKEW_MS = 60 * 1000;

interface LastRecorded {
    capturedAtMs: number;
    percent: number;
}

/** Last row written per `${agent}\u0000${metric}`, process-local by design. */
const lastRecorded = new Map<string, LastRecorded>();
let lastPrunedAt = 0;
/**
 * Tail of the recording queue. Each attempt reads the baselines, writes, and
 * only then advances them, so a concurrent attempt must not read baselines a
 * write still in flight may yet fail to earn.
 */
let recordingTail: Promise<unknown> = Promise.resolve();

export const AGENT_TANK_HISTORY_RETENTION_MS = AGENT_TANK_HISTORY_RETENTION_DAYS * DAY_MS;

/** When the usage in this status was captured, falling back to now. */
function captureTime(status: AgentStatusResponse, now: number): number {
    const parsed = status.lastUpdated ? Date.parse(status.lastUpdated) : Number.NaN;
    return Number.isFinite(parsed) && parsed <= now + MAX_CLOCK_SKEW_MS ? Math.min(parsed, now) : now;
}

interface HistoryRow {
    agent: string;
    metric_key: string;
    metric_label: string;
    model: string | null;
    cycle: string | null;
    percent_used: number;
    recorded_at: string;
    recorded_at_ms: number;
}

interface PendingRecord {
    rows: HistoryRow[];
    /** Baselines to commit once the rows are stored. */
    baselines: Map<string, LastRecorded>;
}

/**
 * Rows this snapshot adds, after per-series deduplication. Reads the
 * baselines without moving them: an insert that fails must leave the
 * snapshot eligible for the next attempt.
 */
function rowsToRecord(agents: Record<string, AgentStatusResponse>, now: number): PendingRecord {
    const rows: HistoryRow[] = [];
    const baselines = new Map<string, LastRecorded>();
    for (const [key, status] of Object.entries(agents)) {
        // A failed read keeps cached usage upstream; recording it again would
        // claim a fresh observation of a value nobody re-measured.
        if (!status || status.error) continue;
        const agent = status.name || key;
        const capturedAtMs = captureTime(status, now);
        for (const metric of extractAgentTankUsageMetrics(agent, status.usage)) {
            const seriesKey = `${agent}\u0000${metric.key}`;
            const previous = baselines.get(seriesKey) ?? lastRecorded.get(seriesKey);
            if (previous) {
                if (capturedAtMs <= previous.capturedAtMs) continue;
                const unchanged = previous.percent === metric.percentUsed;
                if (unchanged && capturedAtMs - previous.capturedAtMs < UNCHANGED_HEARTBEAT_MS) continue;
            }
            baselines.set(seriesKey, { capturedAtMs, percent: metric.percentUsed });
            rows.push({
                agent,
                metric_key: metric.key,
                metric_label: metric.label,
                model: metric.model,
                cycle: metric.cycle,
                percent_used: metric.percentUsed,
                recorded_at: new Date(capturedAtMs).toISOString(),
                recorded_at_ms: capturedAtMs,
            });
        }
    }
    return { rows, baselines };
}

/**
 * Record one observed snapshot (ProPR-facing agent names). Best-effort: usage
 * history must never fail the read that observed it.
 *
 * @returns the number of rows written
 */
export async function recordAgentTankUsageHistory(
    agents: Record<string, AgentStatusResponse> | undefined,
    { database = db, now = Date.now() }: { database?: Knex; now?: number } = {},
): Promise<number> {
    if (!agents) return 0;
    const attempt = recordingTail.then(() => recordSnapshot(agents, database, now));
    recordingTail = attempt;
    return attempt;
}

async function recordSnapshot(agents: Record<string, AgentStatusResponse>, database: Knex, now: number): Promise<number> {
    try {
        const { rows, baselines } = rowsToRecord(agents, now);
        if (rows.length > 0) {
            await database(TABLE).insert(rows);
            for (const [seriesKey, baseline] of baselines) lastRecorded.set(seriesKey, baseline);
        }
        if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
            lastPrunedAt = now;
            await database(TABLE).where('recorded_at_ms', '<', now - AGENT_TANK_HISTORY_RETENTION_MS).delete();
        }
        return rows.length;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Could not record Agent Tank usage history');
        return 0;
    }
}

export interface UsageHistoryQuery {
    /** Inclusive lower bound, epoch ms. */
    since: number;
    /** Inclusive upper bound, epoch ms. */
    until: number;
    /** ProPR-facing agent names to include; all when omitted. */
    agents?: string[];
    /** Only this metric key. */
    metric?: string;
}

/** Locally recorded series, grouped per agent and ordered by time. */
export async function readLocalAgentTankUsageHistory(
    query: UsageHistoryQuery,
    database: Knex = db,
): Promise<AgentTankHistoryAgent[]> {
    let builder = database(TABLE)
        .select('agent', 'metric_key', 'metric_label', 'model', 'cycle', 'percent_used', 'recorded_at')
        .where('recorded_at_ms', '>=', query.since)
        .andWhere('recorded_at_ms', '<=', query.until);
    if (query.agents?.length) builder = builder.whereIn('agent', query.agents);
    if (query.metric) builder = builder.andWhere('metric_key', query.metric);
    const rows = await builder.orderBy([
        { column: 'agent' }, { column: 'metric_key' }, { column: 'recorded_at_ms' }, { column: 'id' },
    ]) as Array<Omit<HistoryRow, 'recorded_at_ms'>>;

    const agents: AgentTankHistoryAgent[] = [];
    let currentAgent: AgentTankHistoryAgent | undefined;
    let currentSeries: AgentTankHistorySeries | undefined;
    for (const row of rows) {
        if (currentAgent?.agent !== row.agent) {
            currentAgent = { agent: row.agent, series: [] };
            agents.push(currentAgent);
            currentSeries = undefined;
        }
        if (currentSeries?.key !== row.metric_key) {
            currentSeries = { key: row.metric_key, label: row.metric_label, model: null, cycle: null, points: [] };
            currentAgent.series.push(currentSeries);
        }
        // Rows are time-ordered, so the descriptive fields end up as the latest.
        currentSeries.label = row.metric_label;
        currentSeries.model = row.model;
        currentSeries.cycle = row.cycle;
        currentSeries.points.push({ t: row.recorded_at, percent: Number(row.percent_used) });
    }
    return agents;
}

/** Forget the per-series write baselines. Test-only seam. */
export function resetAgentTankUsageHistoryTracking(): void {
    lastRecorded.clear();
    lastPrunedAt = 0;
}
