import type { DockerCommandOptions, ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { settleTimeoutStop, settleWatchdogStop } from '../../claude/docker/dockerExecutionSettlement.js';
import { settleCostCapStop } from '../../claude/docker/dockerCostCap.js';
import { configuredDiagnosticSecrets } from '../../diagnostics/managedLogRuntime.js';
import logger from '../../utils/logger.js';
import type { FlyCreateMachineRequest } from './flyMachinesApi.js';
import { startRunPipeline, type RunPipeline } from './runPipeline.js';

interface FlyRunPipeline {
    pipeline: RunPipeline;
    running: AbortSignal;
    policyStop: AbortSignal;
    invokeExecutionCallback(callback: () => void | Promise<void>): void;
    finish(disconnected: boolean): Promise<void>;
    settle(result: ExecutionResult, timedOut: boolean): Promise<ExecutionResult>;
}

export function startFlyRunPipeline(
    request: FlyCreateMachineRequest, runOptions: DockerCommandOptions, signal: AbortSignal,
    context: { name: string; token: string; timeoutMs: number; hasExited: () => boolean },
): FlyRunPipeline | { refusal: Promise<ExecutionResult> } {
    const { name, token, timeoutMs, hasExited } = context;
    const preserveOutput = runOptions.preserveOutputOnTimeout ?? false;
    const args = request.config.init.cmd!;
    const markerArgs = request.config.env.PROPR_REPO_SETUP === '0' ? [] : args;
    const policyStop = new AbortController();
    const running = AbortSignal.any([signal, policyStop.signal]);
    let costMessage: string | undefined;
    const invokeExecutionCallback = (callback: () => void | Promise<void>) => {
        void Promise.resolve().then(callback).catch(error => logger.warn({ run: name, error: (error as Error).message }, 'Agent run callback failed'));
    };
    const started = startRunPipeline(runOptions, {
        command: 'fly-machines', markerArgs, diagnosticArgs: args, environment: request.config.env,
        secrets: [token, ...configuredDiagnosticSecrets(request.config.env)],
        attempt: getExecutionOwnershipContext()?.attemptGeneration, invokeExecutionCallback,
        stopForCostCap: message => { costMessage = message; policyStop.abort(); },
        stopForWatchdog: () => {
            if (running.aborted || hasExited()) return false;
            policyStop.abort();
            return true;
        },
    });
    if (!started.pipeline) return { refusal: started.refusal };
    const { pipeline } = started;
    if (pipeline.captureWorkflowStderr) request.config.env.PROPR_EXECUTION_TIMEOUT_MS = String(timeoutMs);
    return {
        pipeline, running, policyStop: policyStop.signal, invokeExecutionCallback,
        async finish(disconnected: boolean) {
            pipeline.finishOutput({ disconnected });
            const finalCost = await pipeline.finishCost();
            costMessage ??= finalCost ?? undefined;
            await pipeline.watchdog.settled();
            await pipeline.closeLive();
        },
        settle(result: ExecutionResult, timedOut: boolean): Promise<ExecutionResult> {
            return new Promise((resolve, reject) => {
                if (costMessage) settleCostCapStop(costMessage, result, { preserveOutput, resolve, reject });
                else if (pipeline.watchdog.trip) settleWatchdogStop(pipeline.watchdog.trip, result, preserveOutput, { resolve, reject });
                else if (timedOut) settleTimeoutStop(timeoutMs, result, preserveOutput, { resolve, reject });
                else resolve(result);
            });
        },
    };
}
