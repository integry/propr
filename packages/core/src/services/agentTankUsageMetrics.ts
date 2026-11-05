/**
 * Flatten an Agent Tank provider's legacy `usage` payload into one row per
 * limit, for ProPR's own usage history.
 *
 * Ported from Agent Tank 0.10 `src/snapshot-metrics.js` so locally recorded
 * series carry exactly the keys the daemon's `GET /history/:id` uses
 * (`session`, `weeklyAll`, `fiveHour`, `model:<Antigravity quota>`, ...). The
 * two sources then plot and look up identically, and switching an install
 * between bundled and external mode does not fork its series.
 *
 * Only percentage rows are produced: credit balances and other values are not
 * plotted on a 0-100 usage chart.
 */

import { toAgentTankAgent } from './agentTankTypes.js';

export interface AgentTankUsageMetric {
    key: string;
    label: string;
    model: string | null;
    cycle: string | null;
    percentUsed: number;
}

type UsageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UsageRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function round2(value: number): number {
    return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

function metric(
    fields: Omit<AgentTankUsageMetric, 'percentUsed'>,
    percentUsed: unknown,
): AgentTankUsageMetric | null {
    if (!isFiniteNumber(percentUsed)) return null;
    return { ...fields, percentUsed: round2(percentUsed) };
}

// Claude reports distinct limits under fixed keys. `weekly` is the single
// weekly row of older Claude builds and `weeklySonnet` the pre-Fable model row.
const CLAUDE_SECTIONS = [
    { key: 'session', label: 'Current session', model: null, cycle: 'session' },
    { key: 'weeklyAll', label: 'Current week (all models)', model: null, cycle: 'weekly' },
    { key: 'weeklyFable', label: 'Current week (Fable)', model: 'Fable', cycle: 'weekly' },
    { key: 'weeklySonnet', label: 'Current week (Sonnet)', model: 'Sonnet', cycle: 'weekly' },
    { key: 'weekly', label: 'Current week', model: null, cycle: 'weekly' },
] as const;

function claudeMetrics(usage: UsageRecord): AgentTankUsageMetric[] {
    const rows: AgentTankUsageMetric[] = [];
    for (const section of CLAUDE_SECTIONS) {
        const entry = usage[section.key];
        if (!isRecord(entry)) continue;
        const label = typeof entry.label === 'string' && entry.label ? entry.label : section.label;
        const row = metric({ key: section.key, label, model: section.model, cycle: section.cycle }, entry.percent);
        if (row) rows.push(row);
    }
    return rows;
}

/** Antigravity cycle names mapped onto canonical window types. */
const AGY_CYCLES: Record<string, string> = {
    weekly: 'weekly',
    fiveHour: 'five_hour',
    sessionAgy: 'session',
    daily: 'daily',
};

/**
 * Antigravity reports the remaining quota, so `percentUsed` is derived from
 * `usageLeft` when it is present. Grouped pools - including the separately
 * tracked Gemini 4 Argon quota - keep their group as `model`.
 */
function antigravityMetrics(usage: UsageRecord): AgentTankUsageMetric[] {
    if (!Array.isArray(usage.models)) return [];
    const rows: AgentTankUsageMetric[] = [];
    for (const entry of usage.models) {
        if (!isRecord(entry) || typeof entry.model !== 'string' || !entry.model) continue;
        const percentUsed = isFiniteNumber(entry.usageLeft) ? 100 - entry.usageLeft : entry.percentUsed;
        const group = typeof entry.group === 'string' && entry.group ? entry.group : entry.model;
        const cycle = typeof entry.cycle === 'string' ? (AGY_CYCLES[entry.cycle] ?? 'session') : 'session';
        const row = metric({ key: `model:${entry.model}`, label: entry.model, model: group, cycle }, percentUsed);
        if (row) rows.push(row);
    }
    return rows;
}

const CODEX_SECTIONS = [
    { key: 'fiveHour', label: '5h limit', cycle: 'five_hour' },
    { key: 'weekly', label: 'Weekly limit', cycle: 'weekly' },
] as const;

function codexSectionMetrics(source: UsageRecord, model: string | null): AgentTankUsageMetric[] {
    const rows: AgentTankUsageMetric[] = [];
    for (const section of CODEX_SECTIONS) {
        const entry = source[section.key];
        if (!isRecord(entry)) continue;
        const percentUsed = isFiniteNumber(entry.percentUsed)
            ? entry.percentUsed
            : (isFiniteNumber(entry.percentLeft) ? 100 - entry.percentLeft : null);
        const label = typeof entry.label === 'string' && entry.label ? entry.label : section.label;
        const row = metric({
            key: model ? `${model}:${section.key}` : section.key,
            label: model ? `${model} ${label}` : label,
            model,
            cycle: section.cycle,
        }, percentUsed);
        if (row) rows.push(row);
    }
    return rows;
}

function codexMetrics(usage: UsageRecord): AgentTankUsageMetric[] {
    const rows = codexSectionMetrics(usage, null);
    if (Array.isArray(usage.modelLimits)) {
        for (const limit of usage.modelLimits) {
            if (!isRecord(limit)) continue;
            rows.push(...codexSectionMetrics(limit, typeof limit.name === 'string' && limit.name ? limit.name : 'Model'));
        }
    }
    return rows;
}

const EXTRACTORS: Record<string, (usage: UsageRecord) => AgentTankUsageMetric[]> = {
    claude: claudeMetrics,
    agy: antigravityMetrics,
    codex: codexMetrics,
};

/**
 * Percentage metric rows for one provider's usage payload; empty for providers
 * Agent Tank does not track or for an empty payload.
 *
 * @example
 *   extractAgentTankUsageMetrics('claude', { session: { percent: 42 } });
 *   // => [{ key: 'session', label: 'Current session', model: null, cycle: 'session', percentUsed: 42 }]
 */
export function extractAgentTankUsageMetrics(agent: string, usage: unknown): AgentTankUsageMetric[] {
    const extractor = EXTRACTORS[toAgentTankAgent(agent)];
    if (!extractor || !isRecord(usage)) return [];
    return extractor(usage);
}
