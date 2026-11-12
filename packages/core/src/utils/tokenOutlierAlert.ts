import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from './logger.js';
import {
    TOKEN_OUTLIER_MIN_HISTORY, loadTokenOutlierSettings, type TokenOutlierSettings,
} from '../config/tokenOutlierSettings.js';

/**
 * Token-outlier detection for recorded agent executions.
 *
 * Each recorded execution leaves one `llm_execution_token_samples` row. Before
 * it is written, the median total tokens of the last
 * `token_outlier_baseline_runs` successful executions with the same
 * repository, model and execution type is read through the table's composite
 * index; an execution above `token_outlier_multiplier` times that median and
 * above `token_outlier_min_tokens` raises one `warning` Inbox notification per
 * task. No alert fires until the baseline holds `TOKEN_OUTLIER_MIN_HISTORY`
 * executions.
 */

export const TOKEN_SAMPLES_TABLE = 'llm_execution_token_samples';

export interface TokenBaselineKey {
    /** `owner/name`; matched case-insensitively. */
    repository: string;
    model: string;
    executionType: string;
}

export interface TokenUsageSample extends TokenBaselineKey {
    executionId: number | string;
    taskId: string | null;
    success: boolean;
    totalTokens: number;
    /** The issue or pull request the run reports to; 0 or less when none. */
    number: number;
    kind: 'issue' | 'pull_request';
}

export type TokenOutlierEvaluation =
    | { status: 'insufficient_history'; samples: number }
    | { status: 'below_floor' | 'within_baseline' | 'outlier'; samples: number; baselineTokens: number; ratio: number };

export interface TokenOutlierAlert {
    sample: TokenUsageSample;
    baselineTokens: number;
    ratio: number;
    samples: number;
    multiplier: number;
    /** Set when this alert brings the repository to the automation pause threshold. */
    pause: { alerts: number; windowHours: number } | null;
}

export interface TokenOutlierDependencies {
    database?: Knex;
    now?: () => Date;
    loadSettings?: () => Promise<TokenOutlierSettings>;
    notify?: (alert: TokenOutlierAlert) => Promise<TokenOutlierNotificationOutcome>;
}

/**
 * What the notifier did: `delivered` once the Inbox event is persisted,
 * `suppressed` when nothing was raised (notifications off, no recipients).
 * A failed delivery rejects instead.
 */
export type TokenOutlierNotificationOutcome = 'delivered' | 'suppressed';

export interface TokenOutlierResult {
    evaluation: TokenOutlierEvaluation;
    /** True only when this call raised the task's alert and its notification was delivered. */
    alerted: boolean;
}

export function normalizeBaselineRepository(repository: string): string {
    return repository.trim().toLowerCase();
}

/** The median of the values; 0 for none. */
export function medianTokens(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Compares one execution's total tokens with its baseline history (most
 * recent first; only the first `token_outlier_baseline_runs` count).
 */
export function evaluateTokenOutlier(
    totalTokens: number,
    history: readonly number[],
    settings: Pick<TokenOutlierSettings, 'token_outlier_multiplier' | 'token_outlier_min_tokens' | 'token_outlier_baseline_runs'>,
): TokenOutlierEvaluation {
    const window = history.slice(0, settings.token_outlier_baseline_runs);
    if (window.length < TOKEN_OUTLIER_MIN_HISTORY) return { status: 'insufficient_history', samples: window.length };
    const baselineTokens = medianTokens(window);
    const ratio = baselineTokens > 0 ? totalTokens / baselineTokens : Number.POSITIVE_INFINITY;
    const base = { samples: window.length, baselineTokens, ratio };
    if (totalTokens <= settings.token_outlier_min_tokens) return { status: 'below_floor', ...base };
    return { status: totalTokens > baselineTokens * settings.token_outlier_multiplier ? 'outlier' : 'within_baseline', ...base };
}

/** Total tokens of the last `limit` successful executions with the key, most recent first. */
export async function readTokenBaseline(database: Knex, key: TokenBaselineKey, limit: number): Promise<number[]> {
    const rows = await database(TOKEN_SAMPLES_TABLE)
        .where({
            repository: normalizeBaselineRepository(key.repository),
            model_name: key.model,
            execution_type: key.executionType,
            success: true,
        })
        .orderBy('execution_id', 'desc')
        .limit(limit)
        .select('total_tokens') as Array<{ total_tokens: number | string }>;
    return rows.map(row => Number(row.total_tokens)).filter(Number.isFinite);
}

/** Token-outlier alerts raised for any of the repositories since `since`. */
export async function countRecentTokenOutlierAlerts(database: Knex, repositories: readonly string[], since: Date): Promise<number> {
    const normalized = [...new Set(repositories.map(normalizeBaselineRepository))];
    if (normalized.length === 0) return 0;
    const row = await database(TOKEN_SAMPLES_TABLE)
        .whereIn('repository', normalized)
        .where('alerted_at', '>=', since.toISOString())
        .count({ count: '*' })
        .first() as { count?: number | string } | undefined;
    return Number(row?.count ?? 0);
}

async function taskAlreadyAlerted(database: Knex, taskId: string): Promise<boolean> {
    return !!await database(TOKEN_SAMPLES_TABLE).where({ task_id: taskId }).whereNotNull('alerted_at').first('execution_id');
}

/**
 * Records the execution's token sample and alerts when it is an outlier.
 * Errors propagate; the caller treats the whole check as best-effort.
 */
export async function recordTokenUsageSample(sample: TokenUsageSample, deps: TokenOutlierDependencies = {}): Promise<TokenOutlierResult> {
    const { database = db, now = () => new Date(), loadSettings = () => loadTokenOutlierSettings(), notify = notifyTokenOutlier } = deps;
    const settings = await loadSettings();
    // Read before the insert, so an execution is never part of its own baseline.
    const history = await readTokenBaseline(database, sample, settings.token_outlier_baseline_runs);
    const recordedAt = now();
    await database(TOKEN_SAMPLES_TABLE).insert({
        execution_id: sample.executionId,
        task_id: sample.taskId,
        repository: normalizeBaselineRepository(sample.repository),
        model_name: sample.model,
        execution_type: sample.executionType,
        success: sample.success,
        total_tokens: Math.max(0, Math.round(sample.totalTokens)),
        recorded_at: recordedAt.toISOString(),
    });
    const evaluation = evaluateTokenOutlier(sample.totalTokens, history, settings);
    if (evaluation.status !== 'outlier' || !sample.taskId) return { evaluation, alerted: false };
    // One alert per task: later runs of the same task (follow-ups, retries) stay quiet.
    if (await taskAlreadyAlerted(database, sample.taskId)) return { evaluation, alerted: false };

    // The alert is not marked yet: it counts toward the pause only once delivered,
    // so the pause the notification announces includes this pending alert.
    let pause: TokenOutlierAlert['pause'] = null;
    const pauseAlerts = settings.token_outlier_pause_alerts;
    if (pauseAlerts > 0) {
        const windowHours = settings.token_outlier_pause_window_hours;
        const since = new Date(recordedAt.getTime() - windowHours * 3_600_000);
        const alerts = await countRecentTokenOutlierAlerts(database, [sample.repository], since) + 1;
        if (alerts >= pauseAlerts) pause = { alerts, windowHours };
    }
    logger.warn({
        taskId: sample.taskId, repository: sample.repository, model: sample.model, executionType: sample.executionType,
        totalTokens: sample.totalTokens, baselineTokens: evaluation.baselineTokens, ratio: evaluation.ratio, paused: !!pause,
    }, 'Execution token use far above its baseline');
    // A rejection propagates with the task left unmarked, so a later outlier run
    // of the task retries; the notification's per-task deduplication key keeps
    // a retry from raising a second Inbox event.
    const outcome = await notify({
        sample, baselineTokens: evaluation.baselineTokens, ratio: evaluation.ratio, samples: evaluation.samples,
        multiplier: settings.token_outlier_multiplier, pause,
    });
    if (outcome !== 'delivered') return { evaluation, alerted: false };
    // Marked only when no other execution of the task was marked meanwhile, so
    // concurrent outlier runs of one task count once toward the pause.
    const marked = await database(TOKEN_SAMPLES_TABLE)
        .where({ execution_id: sample.executionId })
        .whereNotExists(database(TOKEN_SAMPLES_TABLE).where({ task_id: sample.taskId }).whereNotNull('alerted_at').select('execution_id'))
        .update({ alerted_at: recordedAt.toISOString() });
    return { evaluation, alerted: Number(marked) > 0 };
}

export interface TokenOutlierPause {
    repository: string;
    alerts: number;
    threshold: number;
    windowHours: number;
}

/**
 * The first of the repositories whose scheduled automations are paused: with
 * `token_outlier_pause_alerts` above 0, that many alerts within the trailing
 * `token_outlier_pause_window_hours`. Null when the pause is off or none is.
 */
export async function loadTokenOutlierAutomationPause(
    repositories: readonly string[],
    { database = db, now = () => new Date(), loadSettings = () => loadTokenOutlierSettings() }: Omit<TokenOutlierDependencies, 'notify'> = {},
): Promise<TokenOutlierPause | null> {
    const settings = await loadSettings();
    const threshold = settings.token_outlier_pause_alerts;
    if (threshold <= 0 || repositories.length === 0) return null;
    const windowHours = settings.token_outlier_pause_window_hours;
    const since = new Date(now().getTime() - windowHours * 3_600_000);
    for (const repository of repositories) {
        const alerts = await countRecentTokenOutlierAlerts(database, [repository], since);
        if (alerts >= threshold) return { repository, alerts, threshold, windowHours };
    }
    return null;
}

/** Compact token count, e.g. `1.2M`, `850K`. */
export function formatTokenCount(tokens: number): string {
    const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of units) {
        if (Math.abs(tokens) >= size) return `${Number((tokens / size).toFixed(1))}${suffix}`;
    }
    return String(Math.round(tokens));
}

function formatRatio(ratio: number): string {
    return Number.isFinite(ratio) ? `${Number(ratio.toFixed(1))}×` : 'far above';
}

/** Title and body of the Inbox notification; the model is shown by its display name. */
export function describeTokenOutlierAlert(alert: TokenOutlierAlert, modelName: string): { title: string; body: string } {
    const { sample } = alert;
    const subject = sample.number > 0 ? `${sample.kind === 'pull_request' ? 'PR' : 'issue'} #${sample.number}` : sample.repository;
    const pause = alert.pause
        ? ` Scheduled automations for ${sample.repository} are paused: ${alert.pause.alerts} token alerts in the last ${alert.pause.windowHours} h.`
        : '';
    return {
        title: `Unusually high token use for ${subject}`,
        body: `Used ${formatTokenCount(sample.totalTokens)} tokens, ${formatRatio(alert.ratio)} the baseline of ${formatTokenCount(alert.baselineTokens)} `
            + `(median of the last ${alert.samples} successful ${sample.executionType} runs of ${modelName} in ${sample.repository}; alert above ${alert.multiplier}×).${pause}`,
    };
}

async function repositoryNotificationsEnabled(repository: string): Promise<boolean> {
    const { loadMonitoredReposRaw } = await import('../config/configManager.js');
    const entries = (await loadMonitoredReposRaw()).filter(entry => entry.name.toLowerCase() === repository.toLowerCase());
    // Mirrors the Inbox projection: disabled only when every configured entry opts out.
    return entries.length === 0 || entries.some(entry => (entry as { notificationsEnabled?: boolean }).notificationsEnabled !== false);
}

/**
 * The `warning` Inbox notification on the task, deduplicated per task, for
 * every instance member. Resolves `delivered` once the event is persisted.
 */
export async function notifyTokenOutlier(alert: TokenOutlierAlert): Promise<TokenOutlierNotificationOutcome> {
    const { sample } = alert;
    if (!sample.taskId || !await repositoryNotificationsEnabled(sample.repository)) return 'suppressed';
    const members = await db('instance_members').distinct('github_user_id') as Array<{ github_user_id?: unknown }>;
    const recipients = members.flatMap(row => typeof row.github_user_id === 'string' ? [{ userId: row.github_user_id, pushEnabled: true }] : []);
    if (recipients.length === 0) return 'suppressed';
    const [{ createNotificationEvent }, { getModelName }] = await Promise.all([
        import('../services/notificationService.js'), import('../config/modelAliases.js'),
    ]);
    const { title, body } = describeTokenOutlierAlert(alert, getModelName(sample.model));
    await createNotificationEvent({
        deduplicationKey: `token-outlier:${sample.taskId}`,
        kind: 'task',
        severity: 'warning',
        target: {
            type: 'task', repository: sample.repository, taskId: sample.taskId,
            ...(sample.number > 0 ? sample.kind === 'pull_request' ? { prNumber: sample.number } : { issueNumber: sample.number } : {}),
        },
        title,
        body,
        metadata: {
            event: 'token.outlier', totalTokens: sample.totalTokens, baselineTokens: alert.baselineTokens,
            ratio: Number.isFinite(alert.ratio) ? Number(alert.ratio.toFixed(2)) : null, samples: alert.samples,
            multiplier: alert.multiplier, model: sample.model, executionType: sample.executionType,
            automationsPaused: !!alert.pause,
        },
    }, recipients);
    return 'delivered';
}
