import { setTimeout as delay } from 'node:timers/promises';
import { admitCostExecution, refuseCostExecution, settleCostCapStop } from '../../claude/docker/dockerCostCap.js';
import logger from '../../utils/logger.js';
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
import { MachinesClient, pollBackoff, type MachinesApi } from './fly/api.js';
import { flyConfig } from './fly/config.js';
import { FlyPackageImages, selectFlyPackageImage } from './fly/derivedImage.js';
import { applyOutputDiagnostics, OUTPUT_READ_LIMIT, scanFile, WorkspaceFiles } from './fly/files.js';
import { helper, prepareLaunch, unsupportedFlyMount } from './fly/launch.js';
import { RUN } from './fly/wrapper.js';
import { flyPackageInstallError, logFlyPackageInstall, readFlyPackageInstall, type FlyPackageInstall } from './fly/packages.js';
import { AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS, loadConfiguredAgentRuntimePackages } from './agentRuntimePackageProfile.js';
import { startRunPipeline } from './runPipeline.js';
import type { AgentRunConfigSelection, AgentRunHandle, AgentRunSpec, AgentRuntime } from './types.js';

const POLL_FAILURE_TOLERANCE = 15_000;

interface ExitPollCallbacks {
    bootDeadline: number;
    /** Latest time a runtime package install may still be running; the boot deadline without packages. */
    installDeadline: number;
    start(machine: string): Promise<boolean>;
    activity(): void;
    readUsage(id: string): Promise<boolean>;
}

async function probe(api: MachinesApi, id: string, signal: AbortSignal) {
    const res = await api.exec(id, [...helper, 'probe'], signal).catch(() => undefined);
    return res?.exit_code === 0 && /^(ready|running|installing|install-failed|exited (\d{1,3}))\n(\d+)$/.exec(res.stdout.trim());
}

const probeState = (status: Awaited<ReturnType<typeof probe>>) => status ? status[1] : undefined;

/** Poll the atomic status and consume new usage when a cap is active.
 * Changing byte counts are activity for the stall watchdog. */
async function waitForExit(api: MachinesApi, id: string, forced: AbortSignal, { bootDeadline, installDeadline, start, activity, readUsage }: ExitPollCallbacks) {
    let deadline = bootDeadline;
    let failures = 0;
    let retryUsage = false;
    let previousSize = -1;
    while (!forced.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const status = await probe(api, id, AbortSignal.any([forced, AbortSignal.timeout(remaining)]));
        let retry = !status;
        const state = probeState(status);
        if (state === 'install-failed') return state;
        if (state === 'installing') {
            // The wrapper bounds the install itself; keep polling while it reports progress.
            deadline = Math.max(deadline, Math.min(Date.now() + POLL_FAILURE_TOLERANCE, installDeadline));
        } else if (state === 'ready') {
            if (Date.now() >= deadline) return;
            retry = !await start(id);
        } else if (status) {
            if (status[2] !== undefined) return Number(status[2]);
            const bytes = Number(status[3]);
            const changed = bytes !== previousSize;
            if (changed) activity();
            previousSize = bytes;
            if ((changed || retryUsage) && !forced.aborted) retryUsage = !await readUsage(id);
            retry = retryUsage;
            deadline = Date.now() + POLL_FAILURE_TOLERANCE;
        } else if (!forced.aborted && Date.now() >= deadline) return;
        if (!retry) failures = 0;
        const interval = retry ? pollBackoff(failures++) : 500;
        await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal: forced }).catch(() => {});
    }
    // The grace period may expire between polls, after the clone transport
    // has finished publishing its bundle. Check before forcing deletion.
    const last = await probe(api, id, AbortSignal.timeout(1500));
    // A Machine still installing packages has not started the agent, like one that is ready.
    if (last && !['ready', 'installing', 'install-failed'].includes(last[1])) return last[2] === undefined ? 'running' : Number(last[2]);
}

export class FlyMachinesRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'fly-machines';
    static readonly capabilities = { supportsExtensions: false, supportsRuntimePackages: true, supportsBindMounts: false, supportsRestrictedNetwork: false,
        supportsMcpPrivateNetwork: false, supportsMcpReachableUrl: true, reattach: false, workspaceTransports: ['clone'] as const };
    readonly capabilities = FlyMachinesRuntime.capabilities;
    readonly unsupportedMount = unsupportedFlyMount;

    constructor(private readonly client?: MachinesApi, private readonly environment = process.env,
        private readonly loadPackages: () => Promise<readonly string[]> = loadConfiguredAgentRuntimePackages,
        // Configured runtime packages run from a derived image built once per base image and list. A
        // custom Machines client comes without the registry, so its runs install them at Machine start.
        private readonly images: FlyPackageImages | undefined = client ? undefined : new FlyPackageImages()) {}

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
        const prepared = prepareLaunch(spec, options, config);
        const api = this.client ?? new MachinesClient(config, prepared.secrets);
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
        let workspaceSafeToDestroy = false;
        let credentialsPending = !!prepared.credentialPath;
        let keepLocalBundle = false;
        const machineLocation = () => `Fly app ${config.app}, Machine ${id}, ${RUN}/workspace`;
        const credentialRecovery = () => `Recover credentials from Fly app ${config.app}, Machine ${id}, ${prepared.credentialPath}`;
        let destroyed: Promise<void> | undefined;
        let released: Promise<void> | undefined;
        const reads = new Set<Promise<Buffer | null>>();
        const callbacks: Promise<void>[] = [];
        const timeout = options.timeout ?? 300_000;
        const preserve = options.preserveOutputOnTimeout ?? false;

        // Keep one cleanup owner across wait, stop and release, including after settlement.
        const retryCleanup = async (machine: string, action: string, perform: () => Promise<void>) => {
            try { await perform(); }
            catch (error) {
                logger.warn({ app: config.app, machine, action, err: error }, 'Fly Machine cleanup failed; retrying');
                const retry = delay(5000, undefined, { ref: !exited }).then(() => retryCleanup(machine, action, perform));
                if (!exited) await retry;
            }
        };
        const destroy = () => {
            const machine = id;
            if (machine && workspaceSafeToDestroy && !credentialsPending)
                return destroyed ??= retryCleanup(machine, 'destroy', () => api.destroy(machine));
        };
        let mayHaveStarted = false;
        const requestStop = (signal: NodeJS.Signals = 'SIGTERM', grace = 10_000) => {
            if (exited || stopping || settled) return false;
            stopping = credentialsPending && signal === 'SIGKILL' ? 'SIGTERM' : signal;
            if (!mayHaveStarted) { forced.abort(); return true; }
            if (id) void api.signal(id, stopping).catch(() => {});
            graceTimer = setTimeout(() => forced.abort(), Math.max(stopping !== signal ? 5000 : 0, grace));
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
            const signal = AbortSignal.any([external, forced.signal]);
            const beforeCreation = (error: unknown): never => { external.throwIfAborted(); throw stopping ? new Error('Fly run stopped before creation') : error; };
            // Read for every run, so a Settings change applies to the next Machine. An unreadable
            // or invalid list fails the run rather than starting it without its packages.
            const packages = await selectFlyPackageImage(this.images, prepared, { api, config, packages: await this.loadPackages(), signal, run: spec.name })
                .catch(beforeCreation);
            let packageInstall: FlyPackageInstall | undefined;
            external.throwIfAborted();
            if (stopping) throw new Error('Fly run stopped before creation');
            const failures: string[] = [];
            const started = startRunPipeline(runOptions, {
                liveOutput: false,
                incrementalCaptureCost: {
                    maxRecordBytes: OUTPUT_READ_LIMIT,
                    unreadable: () => {
                        const message = 'Fly stdout record exceeds the 16 MiB cost accounting limit';
                        if (!failures.includes(message)) failures.push(message);
                        requestStop();
                    },
                },
                command: this.kind, markerArgs: prepared.markerArgs, diagnosticArgs: [], secrets: prepared.secrets,
                attempt: ownership?.attemptGeneration, stopForWatchdog: () => requestStop(),
                stopForCostCap: message => { costMessage = message; requestStop(); },
                invokeExecutionCallback: cb => { callbacks.push(Promise.resolve().then(cb).catch(error => { callbackError = error; requestStop(); })); },
            });
            if (started.refusal) return started.refusal;
            const { pipeline } = started;
            const live = startLiveOutputStreaming({ ...options, streamExtraOutput: undefined, onOverflow: () => {} }, () => '', () => '');
            const scrub = new ExtensionStreamRedactor(prepared.secrets);
            const display = (message: string) => {
                const match = /^propr-(stdout|stderr) (.*)$/.exec(message);
                if (!match) return;
                let line: unknown;
                try { line = JSON.parse(match[2]); } catch { return; }
                if (typeof line !== 'string') return;
                const clean = scrub.push(line) + scrub.finish() + '\n';
                const stream = match[1] as 'stdout' | 'stderr';
                output.write(stream, clean);
                live?.[stream](clean);
            };
            const missing: string[] = [];
            const truncated: string[] = [];
            // stdout is append-only. Commit each validated chunk independently so
            // a transient read failure resumes at the first unconsumed byte.
            let stdoutOffset = 0;
            const scanCostOutput = (machine: string, signal?: AbortSignal) =>
                scanFile(api, machine, RUN + '/stdout', { offset: stdoutOffset, signal, limit: Infinity,
                    consume: chunk => {
                        pipeline.write('stdout', chunk);
                        stdoutOffset += chunk.length;
                    },
                });
            const collectOutput = async (machineId: string) => {
                for (const stream of ['stdout', 'stderr'] as const) {
                    try {
                        const size = stream === 'stdout' && pipeline.hasCaptureCost ? await scanCostOutput(machineId)
                            : await scanFile(api, machineId, RUN + '/' + stream, {
                                consume: data => pipeline.write(stream, data), limit: OUTPUT_READ_LIMIT, tail: true,
                            });
                        if (size === null) missing.push(stream);
                        else if (size > MAX_PROVIDER_OUTPUT_BYTES) {
                            truncated.push(stream);
                            const needsHistory = stream === 'stderr' && prepared.markerArgs.length && repositoryWorkflowExecution.getStore();
                            if (size > OUTPUT_READ_LIMIT && needsHistory) missing.push(stream + ' prefix (16 MiB capture read limit)');
                        }
                    } catch { missing.push(stream); }
                }
            };
            const collectExitedMachine = async (machine: string) => {
                await collectOutput(machine);
                try {
                    await workspace.collect(api, machine);
                    workspaceSafeToDestroy = true;
                } catch {
                    const recovery = 'Fly workspace result retrieval failed. Recover from ' + machineLocation();
                    failures.push(recovery);
                    logger.warn({ run: spec.name }, recovery);
                    await workspace.release();
                }
                try {
                    await prepared.commit(api, machine);
                    credentialsPending = false;
                    if (prepared.credentialPath) {
                        const marker = RUN + '/credential-pending';
                        const command = workspaceSafeToDestroy ? ['/bin/rm', '-f', marker] : ['/bin/mv', marker, RUN + '/workspace-pending'];
                        const ack = await api.exec(machine, command).catch(() => undefined);
                        if (ack?.exit_code !== 0) logger.warn({ machine }, 'Fly credential acknowledgement failed after write-back');
                    }
                } catch {
                    failures.push('Fly credential write-back failed. ' + credentialRecovery());
                }
                await destroy();
            };
            const recoverUnconfirmedExit = async (machine: string, running: boolean) => {
                const unstarted = !mayHaveStarted && !running;
                if (unstarted || (running && !credentialsPending)) {
                    if (unstarted) credentialsPending = false;
                    workspaceSafeToDestroy = true;
                    if (running) void api.signal(machine, 'SIGKILL').catch(() => {});
                    await destroy();
                } else {
                    // ALRM stops the child group while leaving an exited guest's files intact.
                    await retryCleanup(machine, 'stop command group', () => api.signal(machine, 'SIGALRM'));
                    const last = await probe(api, machine, AbortSignal.timeout(1500));
                    if (last && last[2] !== undefined) return Number(last[2]);
                    if (credentialsPending) failures.push(credentialRecovery());
                    failures.push('Check for a workspace result at ' + machineLocation());
                }
                missing.push('status');
            };
            let exitCode = -1;
            const createdAt = Date.now();
            try {
                let bootStart = Date.now();
                id = await api.create(prepared.launch, timestamp => { bootStart = Math.min(bootStart, timestamp); });
                void api.logs(id, display, logs.signal).catch(() => {});
                let usageFailureSince: number | undefined;
                const code = stopping ? undefined : await waitForExit(api, id, forced.signal, {
                    bootDeadline: bootStart + config.bootTimeout,
                    installDeadline: bootStart + config.bootTimeout + (packages.length ? AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS + POLL_FAILURE_TOLERANCE : 0),
                    async start(machine) {
                        if (stopping) return false;
                        if (packages.length && !packageInstall) {
                            packageInstall = await readFlyPackageInstall(api, machine, forced.signal);
                            logFlyPackageInstall(spec.name, machine, packages, packageInstall);
                        }
                        // A lost exec response can still have opened the guest gate.
                        mayHaveStarted = true;
                        const response = await api.exec(machine, ['/usr/bin/touch', RUN + '/start'], forced.signal).catch(() => undefined);
                        return response?.exit_code === 0;
                    },
                    activity() {
                        mayHaveStarted = true;
                        pipeline.watchdog.recordActivity();
                        if (!timeoutTimer) timeoutTimer = setTimeout(() => { timedOut = requestStop(); }, timeout);
                    },
                    async readUsage(machine) {
                        if (!pipeline.hasCaptureCost) return true;
                        try {
                            if (await scanCostOutput(machine, forced.signal) === null) throw new Error('Missing stdout');
                            usageFailureSince = undefined;
                            return true;
                        } catch {
                            // Retry from the committed cursor. If capture stays unreadable,
                            // end the chargeable execution while it can still be signalled.
                            usageFailureSince ??= Date.now();
                            if (Date.now() - usageFailureSince >= POLL_FAILURE_TOLERANCE && !stopping) {
                                failures.push('Fly stdout unavailable for live cost accounting');
                                requestStop();
                            }
                            return false;
                        }
                    },
                });
                clearTimeout(timeoutTimer);
                clearTimeout(graceTimer);
                logs.abort();
                if (code === 'install-failed') {
                    // Nothing ran as the agent: no workspace result or credentials to keep.
                    const install = await readFlyPackageInstall(api, id, AbortSignal.timeout(5000));
                    logFlyPackageInstall(spec.name, id, packages, install);
                    void api.exec(id, ['/usr/bin/touch', RUN + '/packages-read']).catch(() => {});
                    credentialsPending = false;
                    workspaceSafeToDestroy = true;
                    await destroy();
                    throw flyPackageInstallError(packages, install);
                }
                const confirmed = typeof code === 'number' ? code : await recoverUnconfirmedExit(id, code === 'running');
                if (typeof confirmed === 'number') {
                    exited = true;
                    exitCode = confirmed;
                    await collectExitedMachine(id);
                }
            } finally {
                logs.abort();
                pipeline.finishOutput({ disconnected: !exited || missing.length > 0, stdoutComplete: exited && !missing.includes('stdout') });
                const finalCost = await pipeline.finishCost();
                costMessage ??= finalCost ?? undefined;
                await Promise.all(callbacks);
                await pipeline.watchdog.settled();
                await pipeline.closeLive();
                await live?.close().catch(() => {});
            }
            if (callbackError) throw callbackError;
            const result: ExecutionResult = pipeline.result(exitCode);
            if (packageInstall) {
                // The install is the Machine's provisioning before the agent; record it so its per-run cost shows.
                result.computeUsage = { runtime: this.kind, wallTimeMs: Date.now() - createdAt, provisioningMs: packageInstall.ms,
                    packageInstallMs: packageInstall.ms, cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null, costUsd: null, costSource: null };
            }
            applyOutputDiagnostics(result, truncated, missing, failures);
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
        }).catch(async error => {
            // Transport cleanup calls release even when wait rejected before complete.
            keepLocalBundle = workspace.hasBundle;
            const recovery: string[] = [];
            if (keepLocalBundle) recovery.push('Recover the workspace bundle from ' + workspace.location);
            else {
                if (id && !workspaceSafeToDestroy) recovery.push('Check for a workspace result at ' + machineLocation());
                await workspace.release();
            }
            if (id && credentialsPending) recovery.push(credentialRecovery());
            if (!recovery.length) throw error;
            const instructions = recovery.join('. ');
            logger.warn({ run: spec.name }, instructions);
            throw new Error(`${error instanceof Error ? error.message : String(error)}. ${instructions}`, { cause: error });
        });
        void result.catch(() => {});
        return {
            spec, get stdout() { return output.get('stdout'); }, get stderr() { return output.get('stderr'); },
            wait: () => result,
            stop: async (signal, grace) => { requestStop(signal, grace); await result.catch(() => {}); await destroy(); },
            isAlive: async () => !settled && !exited,
            inspect: async () => ({ name: spec.name, id, liveness: settled || exited ? 'stopped' : 'running' }),
            get recoveryLocation() {
                if (id && (!workspaceSafeToDestroy || (credentialsPending && !workspace.location))) return machineLocation();
                return workspace.location;
            },
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
                if (!keepLocalBundle && workspace.hasBundle && external.aborted) {
                    // The clone transport can observe cancellation after wait resolves,
                    // before it starts retrieving the snapshot.
                    keepLocalBundle = true;
                    logger.warn({ run: spec.name, location: workspace.location }, 'Cancelled Fly run kept its workspace bundle');
                }
                if (!keepLocalBundle) await workspace.release();
            })().catch(error => { released = undefined; throw error; }),
        };
    }
}
