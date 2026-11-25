import { setTimeout as delay } from 'node:timers/promises';
import { admitCostExecution, refuseCostExecution, settleCostCapStop } from '../../claude/docker/dockerCostCap.js';
import { getActiveRunCostCap } from '../../budget/runCostGuardContext.js';
import { repositoryWorkflowExecution } from '../../workflow/workflowExecution.js';
import { getExecutionOwnershipContext } from '../../claude/docker/dockerExecutionOwnership.js';
import { settleTimeoutStop, settleWatchdogStop } from '../../claude/docker/dockerExecutionSettlement.js';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { startLiveOutputStreaming } from '../../claude/docker/dockerLiveOutputStreaming.js';
import { assertNativeLogAdmission } from '../../diagnostics/managedLogRuntime.js';
import { extensionLaunchForRun } from '../../extensions/extensionLaunchContext.js';
import { ExtensionStreamRedactor } from '../../extensions/extensionOutput.js';
import { MAX_PROVIDER_OUTPUT_BYTES } from '../impl/utils/boundedProviderOutput.js';
import { LazyOutputStreams, type AgentRunOptions } from './dockerRuntime.js';
import { MachinesClient, type MachinesApi } from './fly/api.js';
import { flyConfig } from './fly/config.js';
import { OUTPUT_READ_LIMIT, scanFile, WorkspaceFiles } from './fly/files.js';
import { helper, prepareLaunch, unsupportedFlyMount } from './fly/launch.js';
import { RUN } from './fly/wrapper.js';
import { startRunPipeline } from './runPipeline.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';

const BOOT_TIMEOUT = 120_000;

/** Read only the atomic status and file sizes while the agent is running.
 * Changing byte counts are activity for the stall watchdog. */
async function waitForExit(api: MachinesApi, id: string, forced: AbortSignal, activity: () => void) {
    const probe = async (signal: AbortSignal) => {
        const res = await api.exec(id, [...helper, 'probe'], signal).catch(() => undefined);
        return res?.exit_code === 0 && /^(running|exited (\d{1,3}))\n(\d+)$/.exec(res.stdout.trim());
    };
    let deadline = Date.now() + BOOT_TIMEOUT;
    let previousSize = -1;
    while (!forced.aborted) {
        const status = await probe(forced);
        if (status) {
            if (status[2] !== undefined) return Number(status[2]);
            deadline = Date.now() + 15_000;
            const bytes = Number(status[3]);
            if (bytes !== previousSize) { previousSize = bytes; activity(); }
        } else if (Date.now() >= deadline) return;
        await delay(500, undefined, { signal: forced }).catch(() => {});
    }
    // The grace period may expire between polls, after the clone transport
    // has finished publishing its bundle. Check before forcing deletion.
    const last = await probe(AbortSignal.timeout(1500));
    if (last && last[2] !== undefined) return Number(last[2]);
}

export class FlyMachinesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'fly-machines';
    static readonly capabilities = { supportsExtensions: false, supportsBindMounts: false, supportsRestrictedNetwork: false,
        supportsMcpPrivateNetwork: false, supportsMcpReachableUrl: true, reattach: false, workspaceTransports: ['clone'] as const };
    readonly capabilities = FlyMachinesRuntime.capabilities;
    readonly unsupportedMount = unsupportedFlyMount;

    constructor(private readonly client?: MachinesApi, private readonly environment = process.env) {}

    unsupportedAgentConfig(config: AgentRunConfigSelection | null, spec: AgentRunSpec) {
        if (!['claude', 'codex'].includes(spec.profile.agentType)) return 'Fly Machines supports Claude Code and Codex';
        if (config?.cliVersionType && config.cliVersionType !== 'default') return 'Fly Machines uses the CLI version in PROPR_FLY_IMAGE';
    }

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        if (extensionLaunchForRun(this.kind, [], { ...options, agentRun: { spec } })) throw new Error('Fly Machines does not support extensions');
        if (spec.network.mode !== 'bridge' || spec.network.restriction || spec.network.policy?.mode === 'restricted' ||
            spec.mcpGrant?.network || spec.mcpGrant?.transport === 'private-network') throw new Error('Fly Machines requires open networking and a reachable MCP URL');
        assertNativeLogAdmission(options.diagnostics);
        const config = flyConfig(this.environment);
        const api = this.client ?? new MachinesClient(config);
        const prepared = prepareLaunch(spec, options, config);
        const ownership = getExecutionOwnershipContext();
        const external = AbortSignal.any([options.signal, ownership?.signal].filter((s): s is AbortSignal => !!s));
        const workspace = new WorkspaceFiles();
        const output = new LazyOutputStreams();
        const forced = new AbortController();
        const logs = new AbortController();
        let id: string | undefined;
        let exited = false;
        let settled = false;
        let stopping: NodeJS.Signals | undefined;
        let graceTimer: NodeJS.Timeout | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let timedOut = false;
        let costMessage: string | undefined;
        let callbackError: unknown;
        let destroyed: Promise<void> | undefined;
        let released: Promise<void> | undefined;
        const reads = new Set<Promise<Buffer | null>>();
        const callbacks: Promise<void>[] = [];
        const timeout = options.timeout ?? 300_000;
        const preserve = options.preserveOutputOnTimeout ?? false;

        const destroy = () => {
            const machine = id;
            if (machine) return destroyed ??= api.destroy(machine).catch(error => { destroyed = undefined; throw error; });
        };
        const requestStop = (signal: NodeJS.Signals = 'SIGTERM', grace = 10_000) => {
            if (exited || stopping || settled) return false;
            stopping = signal;
            if (id) void api.signal(id, signal).catch(() => {});
            graceTimer = setTimeout(() => forced.abort(), Math.max(0, grace));
            return true;
        };
        const abort = () => { requestStop(); };
        external.addEventListener('abort', abort, { once: true });
        const runOptions = { ...options, agentRun: { spec } };
        const execute = async (): Promise<ExecutionResult> => {
            external.throwIfAborted();
            const refusal = await admitCostExecution(this.kind, [], runOptions);
            if (refusal) return refuseCostExecution(refusal, preserve);
            external.throwIfAborted();
            if (stopping) throw new Error('Fly run stopped before creation');
            const started = startRunPipeline(runOptions, {
                liveOutput: false,
                command: this.kind, markerArgs: prepared.markerArgs, diagnosticArgs: [], secrets: prepared.secrets,
                attempt: ownership?.attemptGeneration, stopForWatchdog: () => requestStop(),
                stopForCostCap: message => { costMessage = message; requestStop(); },
                invokeExecutionCallback: cb => { callbacks.push(Promise.resolve().then(cb).catch(error => { callbackError = error; requestStop(); })); },
            });
            if (started.refusal) return started.refusal;
            const { pipeline } = started;
            const live = startLiveOutputStreaming({ ...options, streamExtraOutput: undefined, onOverflow: () => {} }, () => '', () => '');
            const display = (message: string) => {
                const match = /^propr-(stdout|stderr) (.*)$/.exec(message);
                if (!match) return;
                let line: unknown;
                try { line = JSON.parse(match[2]); } catch { return; }
                if (typeof line !== 'string') return;
                const scrub = new ExtensionStreamRedactor(prepared.secrets);
                const clean = scrub.push(line) + scrub.finish() + '\n';
                const stream = match[1] as 'stdout' | 'stderr';
                output.write(stream, clean);
                live?.[stream](clean);
            };
            const missing: string[] = [];
            const truncated: string[] = [];
            const failures: string[] = [];
            const collectOutput = async (machineId: string) => {
                for (const stream of ['stdout', 'stderr'] as const) {
                    try {
                        const size = await scanFile(api, machineId, RUN + '/' + stream, {
                            consume: data => pipeline.write(stream, data), limit: OUTPUT_READ_LIMIT, tail: true,
                        });
                        if (size === null) missing.push(stream);
                        else if (size > MAX_PROVIDER_OUTPUT_BYTES) {
                            truncated.push(stream);
                            const needsHistory = stream === 'stdout' ? !options.costCapExempt && getActiveRunCostCap()
                                : prepared.markerArgs.length && repositoryWorkflowExecution.getStore();
                            if (size > OUTPUT_READ_LIMIT && needsHistory) missing.push(stream + ' prefix (16 MiB capture read limit)');
                        }
                    } catch { missing.push(stream); }
                }
            };
            let exitCode = -1;
            try {
                id = await api.create(prepared.launch);
                if (stopping) void api.signal(id, stopping).catch(() => {});
                void api.logs(id, display, logs.signal).catch(() => {});
                const code = await waitForExit(api, id, forced.signal, () => {
                    pipeline.watchdog.recordActivity();
                    if (!timeoutTimer) timeoutTimer = setTimeout(() => { timedOut = requestStop(); }, timeout);
                });
                if (code !== undefined) {
                    exited = true;
                    exitCode = code;
                }
                clearTimeout(timeoutTimer);
                clearTimeout(graceTimer);
                logs.abort();
                if (!exited) {
                    missing.push('status');
                    if (forced.signal.aborted) {
                        void api.signal(id, 'SIGKILL').catch(() => {});
                        await destroy();
                    }
                } else {
                    await collectOutput(id);
                    try { await workspace.collect(api, id); }
                    catch { failures.push('Fly workspace result retrieval failed'); }
                    try { await prepared.commit(api, id); }
                    catch { failures.push('Fly credential write-back failed'); }
                    await destroy();
                }
            } finally {
                logs.abort();
                pipeline.finishOutput({ disconnected: !exited || missing.length > 0 });
                const finalCost = await pipeline.finishCost();
                costMessage ??= finalCost ?? undefined;
                await Promise.all(callbacks);
                await pipeline.watchdog.settled();
                await pipeline.closeLive();
                await live?.close().catch(() => {});
            }
            if (callbackError) throw callbackError;
            const result: ExecutionResult = pipeline.result(exitCode);
            if (truncated.length) result.stderr += '\nFly captured ' + truncated.join(' and ') + ' exceeded the returned output limit; older output was truncated.';
            if (missing.length) failures.unshift('Fly Machine output unavailable: ' + missing.join(', '));
            if (failures.length) {
                result.outputIncomplete = failures.join('. ');
                result.stderr += '\n' + result.outputIncomplete;
                result.exitCode = -1;
            }
            return new Promise((resolve, reject) => {
                if (costMessage) settleCostCapStop(costMessage, result, { preserveOutput: preserve, resolve, reject });
                else if (pipeline.watchdog.trip) settleWatchdogStop(pipeline.watchdog.trip, result, preserve, { resolve, reject });
                else if (timedOut) settleTimeoutStop(timeout, result, preserve, { resolve, reject });
                else if (external.aborted) reject(external.reason);
                else resolve(result);
            });
        };
        const result = execute().finally(async () => {
            settled = true;
            clearTimeout(graceTimer);
            clearTimeout(timeoutTimer);
            external.removeEventListener('abort', abort);
            logs.abort();
            output.end();
            await destroy();
        });
        // No caller can apply a workspace when wait rejects.
        void result.catch(() => workspace.release()).catch(() => {});
        return {
            spec, get stdout() { return output.get('stdout'); }, get stderr() { return output.get('stderr'); },
            wait: () => result,
            stop: async (signal, grace) => { requestStop(signal, grace); await result.catch(() => {}); await destroy(); },
            isAlive: async () => !settled && !exited,
            inspect: async () => ({ name: spec.name, id, liveness: settled || exited ? 'stopped' : 'running' }),
            get recoveryLocation() { return workspace.location; },
            readFile: async file => {
                if (!settled || released) return null;
                const read = workspace.read(file);
                reads.add(read);
                try { return await read; } finally { reads.delete(read); }
            },
            release: () => released ??= (async () => {
                requestStop();
                await result.catch(() => {});
                await destroy();
                await Promise.allSettled(reads);
                await workspace.release();
            })().catch(error => { released = undefined; throw error; }),
        };
    }
}
