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

export type RunUsagePricer = (model: string, totals: RunTokenTotals) => Promise<number>;

export interface RunCostGuardOptions {
    taskId: string;
    inputs: RunCostCapInputs;
    /** Model used to price streamed usage that does not name its model. */
    defaultModel?: string;
    /** Sum of recorded `llm_executions` costs for this task and the attempts it continues. */
    readRecordedSpend: () => Promise<number>;
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
    recordedAtFinish: number;
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
    private lastRecordedUsd = 0;
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
        this.priorSpentUsd = await this.readRecorded(0);
        this.lastRecordedUsd = this.priorSpentUsd;
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
        const recordedAtFinish = await this.readRecorded(this.lastRecordedUsd);
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
        const recorded = await this.readRecorded(this.lastRecordedUsd);
        const live = [...this.live].map(execution => execution.tally);
        const finished = [...this.finished];
        let liveUsd = 0;
        for (const tally of live) liveUsd += await this.cost(tally);
        // A finished execution's row may not be written yet. Recorded growth
        // since it ended is taken as its row, so only the observed usage not yet
        // covered by that growth is added; other recorded calls (analysis
        // before it ended) still count beside it.
        let unrecordedUsd = 0;
        for (const execution of finished) {
            const persistedSinceFinish = Math.max(0, recorded - execution.recordedAtFinish);
            unrecordedUsd += Math.max(0, await this.cost(execution.tally) - persistedSinceFinish);
        }
        const spentUsd = recorded + liveUsd + unrecordedUsd;
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

    private async readRecorded(fallback: number): Promise<number> {
        try {
            const value = await this.options.readRecordedSpend();
            const recorded = Number.isFinite(value) && value > 0 ? value : 0;
            this.lastRecordedUsd = recorded;
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

/** Runs a task's work with its spend cap enforced on every agent container it starts. */
export function runWithRunCostGuard<T>(guard: RunCostGuard, operation: () => Promise<T>): Promise<T> {
    return runWithActiveRunCostCap(guard, operation);
}

export function getActiveRunCostGuard(): RunCostGuard | undefined {
    const active = getActiveRunCostCap();
    return active instanceof RunCostGuard ? active : undefined;
}
