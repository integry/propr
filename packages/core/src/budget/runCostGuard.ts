import logger from '../utils/logger.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';
import { calculateCostWithCachePricing } from '../utils/tokenCalculation.js';
import {
    remainingRunBudget, resolveRunCostCap, runCostCapStopMessage,
    type RunCostCap, type RunCostCapInputs,
} from './runCostCap.js';
import { RunUsageTally, type RunTokenTotals } from './runUsageTally.js';
import { getActiveRunCostCap, runWithActiveRunCostCap, type ActiveRunCostCap, type RunCostExecution } from './runCostGuardContext.js';

export { runCostCapTerminalReason, type RunCostExecution } from './runCostGuardContext.js';
export { RunCostCapExceededError } from './runCostCap.js';

export interface RunCostSnapshot {
    taskId: string;
    cap: RunCostCap;
    /** Estimated spend of this task and the earlier attempts it continues. */
    spentUsd: number;
    /** What earlier attempts had already spent when this run started. */
    priorSpentUsd: number;
    remainingUsd: number;
    percent: number;
}

/** Recorded `llm_executions` cost, with the per-session split that matches a finished execution to its own row. */
export interface RecordedSpend {
    totalUsd: number;
    bySessionUsd?: Readonly<Record<string, number>>;
}

export type RunUsagePricer = (model: string, totals: RunTokenTotals) => Promise<number>;

export interface RunCostGuardOptions {
    taskId: string;
    inputs: RunCostCapInputs;
    /** Model used to price streamed usage that does not name its model. */
    defaultModel?: string;
    /** Sum of recorded `llm_executions` costs for this task and the attempts it continues. */
    readRecordedSpend: () => Promise<number | RecordedSpend>;
    priceUsage?: RunUsagePricer;
    /** Runs once, after every live execution was told to stop. */
    onExceeded?: (snapshot: RunCostSnapshot) => Promise<void> | void;
    /** Called whenever the effective cap changes, e.g. once the workflow file was read. */
    onCapResolved?: (cap: RunCostCap | null) => Promise<void> | void;
    checkIntervalMs?: number;
}

interface LiveExecution {
    tally: RunUsageTally;
    stop: (message: string) => void;
}

interface FinishedExecution {
    tally: RunUsageTally;
    /** Recorded spend read once the execution ended, before its own row could be written. */
    recordedAtFinish: RecordedSpend;
}

const NO_RECORDED_SPEND: RecordedSpend = { totalUsd: 0 };

function normalizeRecordedSpend(value: number | RecordedSpend): RecordedSpend {
    const usd = (amount: unknown) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
    if (typeof value === 'number') return { totalUsd: usd(value) };
    if (!value || typeof value !== 'object') return NO_RECORDED_SPEND;
    const bySessionUsd: Record<string, number> = {};
    for (const [session, amount] of Object.entries(value.bySessionUsd ?? {})) bySessionUsd[session] = usd(amount);
    return { totalUsd: usd(value.totalUsd), ...(value.bySessionUsd ? { bySessionUsd } : {}) };
}

const DEFAULT_CHECK_INTERVAL_MS = 10_000;

const defaultPricer: RunUsagePricer = async (model, totals) => {
    const pricing = await getModelPricing(getOpenRouterId(model));
    if (!pricing) return 0;
    return calculateCostWithCachePricing(model, {
        ...totals,
        totalInputWithCache: totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens,
        totalTokens: totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens + totals.outputTokens,
    }, pricing);
};

/**
 * Enforces one run's spend cap while its agent containers execute. Spend is
 * the recorded cost of the task (including earlier attempts) plus what the
 * live executions have streamed so far. When it reaches the cap, each live
 * execution is stopped once, and `onExceeded` records why. Later executions in
 * the same run (publishing the partial work) are not stopped again.
 */
export class RunCostGuard implements ActiveRunCostCap {
    readonly taskId: string;
    private inputs: RunCostCapInputs;
    private resolvedCap: RunCostCap | null;
    private readonly options: RunCostGuardOptions;
    private readonly live = new Set<LiveExecution>();
    private readonly finished: FinishedExecution[] = [];
    private priorSpentUsd = 0;
    private lastRecorded: RecordedSpend = NO_RECORDED_SPEND;
    private triggered = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private checking: Promise<RunCostSnapshot | null> | null = null;
    private exceededSnapshot: RunCostSnapshot | null = null;
    private stopMessage: string | null = null;
    private publishedCap = false;

    constructor(options: RunCostGuardOptions) {
        this.options = options;
        this.taskId = options.taskId;
        this.inputs = { ...options.inputs };
        this.resolvedCap = resolveRunCostCap(this.inputs);
    }

    get cap(): RunCostCap | null { return this.resolvedCap; }
    get exceeded(): boolean { return this.triggered; }
    get exceededWith(): RunCostSnapshot | null { return this.exceededSnapshot; }

    /** Reads what earlier attempts spent; the cap for this attempt is what remains. */
    async start(): Promise<{ cap: RunCostCap | null; priorSpentUsd: number; remainingUsd: number | null }> {
        this.priorSpentUsd = (await this.readRecorded(NO_RECORDED_SPEND)).totalUsd;
        await this.publishCap();
        const remainingUsd = this.resolvedCap ? remainingRunBudget(this.resolvedCap.capUsd, this.priorSpentUsd) : null;
        if (this.resolvedCap) {
            logger.info({ taskId: this.taskId, capUsd: this.resolvedCap.capUsd, source: this.resolvedCap.source, priorSpentUsd: this.priorSpentUsd, remainingUsd },
                'Run spend cap resolved');
        }
        return { cap: this.resolvedCap, priorSpentUsd: this.priorSpentUsd, remainingUsd };
    }

    /** Applies the repository workflow's `limits.max_cost_usd` once the workflow is known. */
    async setWorkflowCap(value: unknown): Promise<void> {
        if (this.inputs.workflow === value) return;
        this.inputs = { ...this.inputs, workflow: value };
        const next = resolveRunCostCap(this.inputs);
        if (next?.capUsd === this.resolvedCap?.capUsd && next?.source === this.resolvedCap?.source) return;
        this.resolvedCap = next;
        await this.publishCap();
    }

    beginExecution(stop: (message: string) => void, model?: string): RunCostExecution | null {
        if (this.triggered || !this.resolvedCap) return null;
        const execution: LiveExecution = { tally: new RunUsageTally(model), stop };
        this.live.add(execution);
        this.ensureTimer();
        // A retry whose earlier attempts used the whole budget stops right away.
        void this.check();
        let finishing: Promise<string | null> | null = null;
        return {
            observeLine: line => execution.tally.observeLine(line),
            finish: () => {
                finishing ??= this.finishExecution(execution);
                return finishing;
            },
        };
    }

    /**
     * Usage streamed after the last periodic check still counts: an execution
     * that crossed the cap and exited before the next interval ends with the
     * spend-cap outcome instead of completing normally.
     */
    private async finishExecution(execution: LiveExecution): Promise<string | null> {
        // The execution's row is written only after it returns, so whatever is
        // recorded now belongs to other calls; growth beyond this may be its own.
        const recordedAtFinish = await this.readRecorded(this.lastRecorded);
        if (this.live.delete(execution)) this.finished.push({ tally: execution.tally, recordedAtFinish });
        if (this.live.size === 0) this.stopTimer();
        // A check already in flight may have priced the execution before its
        // final usage arrived; only one that starts after the move sees it all.
        if (this.checking) await this.checking.catch(() => null);
        await this.check().catch(() => null);
        return this.triggered ? this.stopMessage : null;
    }

    /** Re-evaluates spend; stops the live executions once when it reaches the cap. */
    check(): Promise<RunCostSnapshot | null> {
        this.checking ??= this.evaluate().finally(() => { this.checking = null; });
        return this.checking;
    }

    close(): void {
        this.stopTimer();
        this.live.clear();
    }

    private async evaluate(): Promise<RunCostSnapshot | null> {
        const cap = this.resolvedCap;
        if (this.triggered || !cap) return null;
        const snapshot = await this.snapshot(cap);
        if (this.triggered || snapshot.spentUsd < cap.capUsd) return null;
        this.triggered = true;
        this.exceededSnapshot = snapshot;
        this.stopTimer();
        const message = runCostCapStopMessage(cap, snapshot.spentUsd);
        this.stopMessage = message;
        logger.warn({ taskId: this.taskId, capUsd: cap.capUsd, source: cap.source, spentUsd: snapshot.spentUsd, liveExecutions: this.live.size },
            'Run spend cap exceeded; stopping the agent');
        for (const execution of this.live) {
            try { execution.stop(message); } catch (error) {
                logger.error({ taskId: this.taskId, error: (error as Error).message }, 'Failed to stop an execution at the spend cap');
            }
        }
        try { await this.options.onExceeded?.(snapshot); } catch (error) {
            logger.error({ taskId: this.taskId, error: (error as Error).message }, 'Failed to record the spend cap stop');
        }
        return snapshot;
    }

    private async snapshot(cap: RunCostCap): Promise<RunCostSnapshot> {
        // Recorded rows are written only after an execution finished, so
        // reading them before capturing the live set cannot count a live
        // execution twice. Both collections are captured together, before
        // pricing awaits: an execution finishing meanwhile moves its tally
        // from live to finished and would otherwise be priced in both.
        const recorded = await this.readRecorded(this.lastRecorded);
        const live = [...this.live].map(execution => execution.tally);
        const finished = [...this.finished];
        let liveUsd = 0;
        for (const tally of live) liveUsd += await this.cost(tally);
        const finishedUsd: number[] = [];
        for (const execution of finished) finishedUsd.push(await this.cost(execution.tally));
        const spentUsd = recorded.totalUsd + liveUsd + unrecordedUsd(recorded, finished, finishedUsd);
        return {
            taskId: this.taskId, cap, spentUsd, priorSpentUsd: this.priorSpentUsd,
            remainingUsd: remainingRunBudget(cap.capUsd, spentUsd),
            percent: cap.capUsd > 0 ? (spentUsd / cap.capUsd) * 100 : 0,
        };
    }

    private async cost(tally: RunUsageTally): Promise<number> {
        const model = tally.model ?? this.options.defaultModel;
        let priced = 0;
        if (model) {
            try { priced = await (this.options.priceUsage ?? defaultPricer)(model, tally.totals); } catch (error) {
                logger.debug({ taskId: this.taskId, model, error: (error as Error).message }, 'Could not price live usage');
            }
        }
        return Math.max(priced, tally.reportedCostUsd);
    }

    private async readRecorded(fallback: RecordedSpend): Promise<RecordedSpend> {
        try {
            const recorded = normalizeRecordedSpend(await this.options.readRecordedSpend());
            this.lastRecorded = recorded;
            return recorded;
        } catch (error) {
            logger.warn({ taskId: this.taskId, error: (error as Error).message }, 'Could not read recorded task spend');
            return fallback;
        }
    }

    private async publishCap(): Promise<void> {
        // An uncapped run that never had a cap has nothing to record or clear.
        if (!this.resolvedCap && !this.publishedCap) return;
        this.publishedCap = this.resolvedCap !== null;
        try { await this.options.onCapResolved?.(this.resolvedCap); } catch (error) {
            logger.warn({ taskId: this.taskId, error: (error as Error).message }, 'Could not store the resolved spend cap');
        }
    }

    private ensureTimer(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.check(); }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
        this.timer.unref?.();
    }

    private stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

/**
 * Observed usage of finished executions whose rows are not recorded yet (or
 * failed to be). An execution that reported its session is matched only to
 * that session's recorded growth since it ended. Without a session (or a
 * per-session split), recorded growth outside those sessions since it ended
 * may be its row; that growth is shared, so each recorded dollar covers at
 * most one execution and the rest still counts.
 */
function unrecordedUsd(recorded: RecordedSpend, finished: readonly FinishedExecution[], observedUsd: readonly number[]): number {
    const matched = new Set<string>();
    if (recorded.bySessionUsd) {
        for (const { tally } of finished) if (tally.sessionId) matched.add(tally.sessionId);
    }
    const keyOf = (execution: FinishedExecution) => execution.tally.sessionId && matched.has(execution.tally.sessionId) ? execution.tally.sessionId : null;
    const amount = (spend: RecordedSpend, key: string | null): number => {
        if (key !== null) return spend.bySessionUsd?.[key] ?? 0;
        let other = spend.totalUsd;
        for (const session of matched) other -= spend.bySessionUsd?.[session] ?? 0;
        return other;
    };
    // Growth since the earliest finish of each group is the most its executions' rows can account for.
    const available = new Map<string | null, number>();
    for (const execution of finished) {
        const key = keyOf(execution);
        const growth = Math.max(0, amount(recorded, key) - amount(execution.recordedAtFinish, key));
        available.set(key, Math.max(available.get(key) ?? 0, growth));
    }
    let total = 0;
    finished.forEach((execution, index) => {
        const key = keyOf(execution);
        const sinceFinish = Math.max(0, amount(recorded, key) - amount(execution.recordedAtFinish, key));
        const covered = Math.min(observedUsd[index], sinceFinish, available.get(key) ?? 0);
        available.set(key, (available.get(key) ?? 0) - covered);
        total += observedUsd[index] - covered;
    });
    return total;
}

/** Runs a task's work with its spend cap enforced on every agent container it starts. */
export function runWithRunCostGuard<T>(guard: RunCostGuard, operation: () => Promise<T>): Promise<T> {
    return runWithActiveRunCostCap(guard, operation);
}

export function getActiveRunCostGuard(): RunCostGuard | undefined {
    const active = getActiveRunCostCap();
    return active instanceof RunCostGuard ? active : undefined;
}
