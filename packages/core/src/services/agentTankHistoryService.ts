/**
 * Usage history for the Agent Tank charts, from whichever source has it.
 *
 * An external Agent Tank 0.10+ daemon keeps its own SQLite history and refreshes
 * on its own schedule, so it knows more than ProPR saw; its series are used per
 * agent whenever it answers with any. Everything else - bundled mode, an older
 * daemon, a daemon with history switched off or unreachable - falls back to
 * what ProPR recorded from the snapshots it observed. Both sources use the same
 * metric keys, so the client cannot tell them apart except by `source`.
 */

import {
    AGENT_TANK_HISTORY_RETENTION_DAYS,
    type AgentTankHistoryAgent,
    type AgentTankHistoryPoint,
    type AgentTankHistoryResponse,
    type AgentTankHistorySeries,
    type AgentTankHistorySource,
} from '@propr/shared';
import { loadAgentTankSettings } from '../config/configManager.js';
import logger from '../utils/logger.js';
import { getAllStatuses } from './agentTankService.js';
import { toAgentTankAgent, toProprAgent } from './agentTankTypes.js';
import { readLocalAgentTankUsageHistory, type UsageHistoryQuery } from './agentTankUsageHistory.js';

const DAEMON_HISTORY_TIMEOUT_MS = 5000;
/** More points than a chart can draw at sidebar or page width. */
export const MAX_HISTORY_POINTS_PER_SERIES = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Thin a series to at most `maxPoints` by keeping the lowest and the highest
 * reading of each equal time bucket, in time order. Every recorded extreme
 * therefore survives, so a short spike still reaches the chart and the range's
 * lowest and highest readings are the recorded ones. The first and last points
 * always survive too, so the line still spans the whole range and ends on the
 * current value.
 */
export function downsampleHistoryPoints(
    points: AgentTankHistoryPoint[],
    maxPoints: number = MAX_HISTORY_POINTS_PER_SERIES,
): AgentTankHistoryPoint[] {
    if (points.length <= maxPoints || maxPoints < 4) return points;
    const first = Date.parse(points[0].t);
    const last = Date.parse(points[points.length - 1].t);
    const span = last - first;
    // Without a usable time span every interior point shares one bucket.
    const timed = Number.isFinite(span) && span > 0;
    const buckets = Math.floor((maxPoints - 2) / 2);
    const kept: AgentTankHistoryPoint[] = [points[0]];
    let bucketStart = 1;
    const flush = (end: number) => {
        if (end <= bucketStart) return;
        let low = bucketStart;
        let high = bucketStart;
        for (let index = bucketStart + 1; index < end; index++) {
            const value = points[index].percent;
            if (value === null) continue;
            const lowest = points[low].percent;
            const highest = points[high].percent;
            if (lowest === null || value < lowest) low = index;
            if (highest === null || value > highest) high = index;
        }
        kept.push(points[Math.min(low, high)]);
        if (low !== high) kept.push(points[Math.max(low, high)]);
    };
    let currentBucket = -1;
    for (let index = 1; index < points.length - 1; index++) {
        const bucket = timed
            ? Math.max(0, Math.min(buckets - 1, Math.floor(((Date.parse(points[index].t) - first) / span) * buckets)))
            : 0;
        if (bucket !== currentBucket) {
            flush(index);
            bucketStart = index;
            currentBucket = bucket;
        }
    }
    flush(points.length - 1);
    kept.push(points[points.length - 1]);
    return kept;
}

/** Normalize one daemon series, keeping only plottable percentage points. */
function parseDaemonSeries(value: unknown): AgentTankHistorySeries | undefined {
    if (!isRecord(value) || typeof value.key !== 'string') return undefined;
    if (typeof value.unit === 'string' && value.unit !== 'percent') return undefined;
    const points = Array.isArray(value.points)
        ? value.points.filter(isRecord)
            .filter(point => typeof point.t === 'string' && typeof point.percent === 'number' && Number.isFinite(point.percent))
            .map(point => ({ t: point.t as string, percent: point.percent as number }))
        : [];
    if (points.length === 0) return undefined;
    return {
        key: value.key,
        label: typeof value.label === 'string' && value.label ? value.label : value.key,
        model: typeof value.model === 'string' ? value.model : null,
        cycle: typeof value.cycle === 'string' ? value.cycle : null,
        points,
    };
}

/** One agent's history from an external daemon; undefined when it has none. */
async function readDaemonHistory(
    baseUrl: string,
    agent: string,
    query: UsageHistoryQuery,
): Promise<AgentTankHistorySeries[] | undefined> {
    const params = new URLSearchParams({ since: String(query.since), until: String(query.until) });
    if (query.metric) params.set('metric', query.metric);
    const url = `${baseUrl}/history/${encodeURIComponent(toAgentTankAgent(agent))}?${params}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DAEMON_HISTORY_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return undefined;
        const body: unknown = await response.json();
        // 0.9.x answered with a list of raw snapshots and no `store`; a daemon
        // with history off reports `store: "none"`. Neither is a series answer.
        if (!isRecord(body) || body.store !== 'sqlite' || !Array.isArray(body.series)) return undefined;
        const series = body.series.map(parseDaemonSeries).filter((entry): entry is AgentTankHistorySeries => !!entry);
        return series.length > 0 ? series : undefined;
    } catch (error) {
        logger.debug({ agent, error: (error as Error).message }, 'Agent Tank history unavailable; using recorded history');
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

function withDownsampledPoints(agents: AgentTankHistoryAgent[]): AgentTankHistoryAgent[] {
    return agents.map(entry => ({
        agent: entry.agent,
        series: entry.series.map(series => ({ ...series, points: downsampleHistoryPoints(series.points) })),
    }));
}

/**
 * Usage history for the charts.
 *
 * @example
 *   await readAgentTankUsageHistory({ since: Date.now() - 10 * 3600_000, until: Date.now(), agents: ['claude'] });
 *   // => { enabled: true, source: 'propr', agents: [{ agent: 'claude', series: [{ key: 'session', ... }] }] }
 */
export async function readAgentTankUsageHistory(query: UsageHistoryQuery): Promise<AgentTankHistoryResponse> {
    const settings = await loadAgentTankSettings();
    if (settings.mode === 'disabled') return { enabled: false, agents: [] };

    const local = await readLocalAgentTankUsageHistory(query);
    if (settings.mode !== 'external') {
        return {
            enabled: true,
            source: 'propr',
            retentionDays: AGENT_TANK_HISTORY_RETENTION_DAYS,
            agents: withDownsampledPoints(local),
        };
    }

    // The daemon is asked about every agent it currently reports plus every
    // agent ProPR has history for, so neither source can hide the other's.
    const requested = query.agents?.length
        ? query.agents
        : [...new Set([...Object.keys(await getAllStatuses() ?? {}), ...local.map(entry => entry.agent)])];
    const answers = await Promise.all(requested.map(async agent => ({
        agent,
        daemon: await readDaemonHistory(settings.url, agent, query),
    })));
    const localByAgent = new Map(local.map(entry => [entry.agent, entry.series]));
    let source: AgentTankHistorySource = 'propr';
    const agents: AgentTankHistoryAgent[] = [];
    for (const { agent, daemon } of answers) {
        const proprAgent = toProprAgent(agent);
        if (daemon) source = 'agent-tank';
        const series = daemon ?? localByAgent.get(proprAgent);
        if (series?.length) agents.push({ agent: proprAgent, series });
    }
    return {
        enabled: true,
        source,
        retentionDays: AGENT_TANK_HISTORY_RETENTION_DAYS,
        agents: withDownsampledPoints(agents),
    };
}
