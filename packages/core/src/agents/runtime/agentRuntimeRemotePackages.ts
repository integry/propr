import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { AGENT_IMAGE_PACKAGE_BASE, loadSpritePackageBase, type AgentRuntimePackageBase } from './agentRuntimePackageBases.js';
import {
    assertAgentRuntimePackagesInIndex, findUnavailableAgentRuntimePackages, getAgentImagePackageIndex, indexCheckedAgentRuntimePackages,
    warmAgentRuntimePackageIndexes, AGENT_RUNTIME_PACKAGE_INDEX_WARNING, type AgentRuntimePackageLoader, type AgentRuntimePackageTarget,
} from './agentRuntimePackageIndex.js';
import { AGENT_RUNTIME_PACKAGES_CONFIG_KEY, agentRuntimeUsage, normalizeAgentRuntimePackageList, validateAgentRuntimePackages,
    type AgentRuntimeUsage, type RemoteAgentRuntimeOptions } from './agentRuntimePackageProfile.js';
import { FLY_MACHINES_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME } from './runtimeSelection.js';

/**
 * Remote runtimes (Sprites, Fly Machines) have no image build to wait for, so each keeps its own
 * accepted package list in the package state (`remote.<runtime>`). The build job accepts a list for a
 * runtime once it passes that runtime's package index check; until then, and when it fails, the runtime
 * keeps installing its previous list. Saving or applying a list in Settings therefore changes nothing
 * on a remote runtime while the change is still `pending`, and a failed Docker build on a mixed
 * instance does not hold remote runtimes back (Settings shows each runtime's own state).
 */
export type RemoteAgentRuntime = typeof SPRITES_AGENT_RUNTIME | typeof FLY_MACHINES_AGENT_RUNTIME;
export const REMOTE_AGENT_RUNTIMES: readonly RemoteAgentRuntime[] = [FLY_MACHINES_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME];
export const AGENT_RUNTIME_LABELS: Record<string, string> = { docker: 'Docker', [SPRITES_AGENT_RUNTIME]: 'Sprites', [FLY_MACHINES_AGENT_RUNTIME]: 'Fly Machines' };
export const isRemoteAgentRuntime = (runtime: string): runtime is RemoteAgentRuntime => (REMOTE_AGENT_RUNTIMES as readonly string[]).includes(runtime);
const runtimeLabel = (runtime: string) => AGENT_RUNTIME_LABELS[runtime] ?? runtime;

export interface RemoteRuntimePackageRecord {
    /** The accepted list this runtime installs. */
    packages: string[];
    /** `failed` when the last requested list did not pass this runtime's check; `packages` stays the previous list. */
    status: 'ready' | 'failed';
    /** The refused list, when `failed`. */
    requested?: string[];
    error?: string;
    /** The index could not be fetched, so the list was accepted unchecked (apt still reports a bad name). */
    warning?: string;
    /** The package base the list was checked against, e.g. "Ubuntu 26.04 LTS (resolute)". */
    base: string;
    /** The build that produced this record. */
    buildId?: string;
    updatedAt: string;
}
export type RemoteRuntimePackageRecords = Partial<Record<RemoteAgentRuntime, RemoteRuntimePackageRecord>>;

export function normalizeRemoteRuntimePackageRecords(value: unknown): RemoteRuntimePackageRecords | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const records: RemoteRuntimePackageRecords = {};
    for (const runtime of REMOTE_AGENT_RUNTIMES) {
        const raw = (value as Record<string, Partial<RemoteRuntimePackageRecord> | undefined>)[runtime];
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.packages)) continue;
        records[runtime] = {
            packages: normalizeAgentRuntimePackageList(raw.packages),
            status: raw.status === 'failed' ? 'failed' : 'ready',
            ...(Array.isArray(raw.requested) && { requested: normalizeAgentRuntimePackageList(raw.requested) }),
            ...(typeof raw.error === 'string' && { error: raw.error }),
            ...(typeof raw.warning === 'string' && { warning: raw.warning }),
            base: typeof raw.base === 'string' ? raw.base : '',
            ...(typeof raw.buildId === 'string' && { buildId: raw.buildId }),
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
        };
    }
    return Object.keys(records).length ? records : undefined;
}

/** The package base a remote runtime installs from: Fly Machines run the agent image, Sprites Fly's Sprite base. */
export async function remoteRuntimePackageBase(runtime: RemoteAgentRuntime): Promise<AgentRuntimePackageBase> {
    return runtime === SPRITES_AGENT_RUNTIME ? loadSpritePackageBase() : AGENT_IMAGE_PACKAGE_BASE;
}

/**
 * The list `runtime` installs: its accepted record, or, for state saved before runtimes kept their own
 * record, the list last applied (`activePackages`), never the desired list awaiting a build. Strict like
 * the old desired-list read: a failed read or an invalid stored list throws, so a run never starts
 * without packages it was configured to have; an absent setting means none.
 */
export async function loadAcceptedRemoteAgentRuntimePackages(runtime: RemoteAgentRuntime, client?: Knex): Promise<string[]> {
    const store = await import('../../config/configStore.js');
    const raw = client ? await store.getConfigWithClient<unknown>(AGENT_RUNTIME_PACKAGES_CONFIG_KEY, null, client, true)
        : await store.getConfigStrict<unknown>(AGENT_RUNTIME_PACKAGES_CONFIG_KEY, null);
    if (!raw || typeof raw !== 'object') return [];
    const state = raw as { remote?: Record<string, { packages?: unknown } | undefined>; activePackages?: unknown };
    const packages = state.remote?.[runtime]?.packages ?? state.activePackages;
    if (packages === undefined || packages === null) return [];
    const validation = validateAgentRuntimePackages(packages);
    if (!validation.valid) throw new Error(`Accepted ${runtimeLabel(runtime)} runtime packages are invalid: ${validation.errors.join('; ')}`);
    return validation.packages;
}

/** The package source a remote runtime reads: its accepted list, re-checked against its own base before a new install. */
export function remoteRuntimePackageSource(runtime: RemoteAgentRuntime): AgentRuntimePackageLoader {
    return indexCheckedAgentRuntimePackages(() => loadAcceptedRemoteAgentRuntimePackages(runtime),
        async (packages, signal) => assertAgentRuntimePackagesInIndex(packages, signal, await remoteRuntimePackageBase(runtime), runtimeLabel(runtime)));
}

/**
 * Checks `packages` for each remote runtime against its own base and returns the new records: accepted
 * when the check passes (or the index cannot be fetched, with a warning), otherwise failed with the
 * runtime's previous list kept.
 */
export async function acceptRemoteAgentRuntimePackages(packages: readonly string[], runtimes: readonly RemoteAgentRuntime[],
    previous: { remote?: RemoteRuntimePackageRecords; activePackages: string[] }, { buildId, signal }: { buildId?: string; signal?: AbortSignal } = {},
): Promise<RemoteRuntimePackageRecords> {
    const records: RemoteRuntimePackageRecords = { ...previous.remote };
    for (const runtime of runtimes) {
        const base = await remoteRuntimePackageBase(runtime);
        const updatedAt = new Date().toISOString();
        const accepted = { packages: [...packages], status: 'ready' as const, base: base.label, ...(buildId && { buildId }), updatedAt };
        if (packages.length === 0) { records[runtime] = accepted; continue; }
        let index;
        try { index = await getAgentImagePackageIndex(signal, base); }
        catch (error) {
            if (signal?.aborted) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            records[runtime] = { ...accepted, warning: `${AGENT_RUNTIME_PACKAGE_INDEX_WARNING}: the ${base.label} package index could not be fetched (${reason})` };
            continue;
        }
        const { errors } = findUnavailableAgentRuntimePackages(index, packages);
        if (errors.length === 0) { records[runtime] = accepted; continue; }
        const kept = previous.remote?.[runtime]?.packages ?? previous.activePackages;
        records[runtime] = { packages: [...kept], status: 'failed', requested: [...packages], base: base.label,
            error: `${runtimeLabel(runtime)} (${base.label}): ${errors.join('; ')}`, ...(buildId && { buildId }), updatedAt };
        logger.warn({ runtime, base: base.label, errors }, 'Agent runtime packages not accepted for a remote runtime; it keeps its previous list');
    }
    return records;
}

export type AgentRuntimePackageRuntimeStatus = 'disabled' | 'pending' | 'building' | 'ready' | 'failed';
export interface AgentRuntimePackageRuntimeState {
    runtime: string;
    label: string;
    status: AgentRuntimePackageRuntimeStatus;
    /** The list this runtime applies now. */
    activePackages: string[];
    /** Where the packages come from: "derived Docker image" or the package base. */
    source: string;
    error?: string;
    warning?: string;
}

interface DescribedState {
    status: AgentRuntimePackageRuntimeStatus; activePackages: string[]; buildId?: string; error?: string; remote?: RemoteRuntimePackageRecords;
}

function remoteRuntimeState(runtime: RemoteAgentRuntime, state: DescribedState): AgentRuntimePackageRuntimeState {
    const building = state.status === 'pending' || state.status === 'building';
    const record = state.remote?.[runtime];
    // A record from an older build does not describe the change still pending.
    const current = record && (!building || record.buildId === state.buildId) ? record : undefined;
    const activePackages = [...(record?.packages ?? state.activePackages)];
    const idle = activePackages.length ? 'ready' : 'disabled';
    const status: AgentRuntimePackageRuntimeStatus = current?.status === 'failed' ? 'failed' : current || !building ? idle : 'pending';
    return { runtime, label: runtimeLabel(runtime), status, activePackages,
        source: record?.base || (runtime === SPRITES_AGENT_RUNTIME ? 'Sprite base image' : AGENT_IMAGE_PACKAGE_BASE.label),
        ...(current?.error && { error: current.error }), ...(current?.warning && { warning: current.warning }) };
}

/** Each runtime in use with the list it applies now and its own status, for Settings. */
export function describeAgentRuntimePackageRuntimes(state: DescribedState, usage: AgentRuntimeUsage): AgentRuntimePackageRuntimeState[] {
    const docker: AgentRuntimePackageRuntimeState[] = usage.docker ? [{ runtime: 'docker', label: 'Docker', status: state.status,
        activePackages: [...state.activePackages], source: 'derived Docker image', ...(state.status === 'failed' && state.error && { error: state.error }) }] : [];
    return [...docker, ...REMOTE_AGENT_RUNTIMES.filter(runtime => usage.runtimes.includes(runtime)).map(runtime => remoteRuntimeState(runtime, state))];
}

/**
 * The build job's outcome on a worker with only remote runtimes: `ready` with the list applied when every
 * runtime accepted it, otherwise `failed` with each refusal, and the last applied list kept.
 */
export function remoteOnlyBuildOutcome(packages: readonly string[], runtimes: readonly RemoteAgentRuntime[], records: RemoteRuntimePackageRecords | undefined,
    { activePackages: previous, appliedBy }: { activePackages: string[]; appliedBy: string }) {
    const failures = runtimes.flatMap(runtime => records?.[runtime]?.status === 'failed' ? [records[runtime]!.error ?? `${runtimeLabel(runtime)} refused the list`] : []);
    const warnings = runtimes.flatMap(runtime => records?.[runtime]?.warning ?? []);
    return {
        activePackages: failures.length ? previous : [...packages],
        status: failures.length ? 'failed' as const : 'ready' as const,
        error: failures.length ? failures.join('; ') : undefined,
        buildLog: [`${appliedBy}.`, ...warnings, ...failures].join('\n'),
    };
}

/**
 * The index checks Settings runs for the remote runtimes in use: one target per runtime, with the base
 * it installs from (several runtimes on one base are merged by the validator).
 */
export async function remoteAgentRuntimePackageTargets(options: RemoteAgentRuntimeOptions = {}): Promise<AgentRuntimePackageTarget[]> {
    const usage = await agentRuntimeUsage(undefined, process.env, options);
    return Promise.all(usage.runtimes.filter(isRemoteAgentRuntime).map(async runtime => ({ runtimes: [runtimeLabel(runtime)], base: await remoteRuntimePackageBase(runtime) })));
}

/**
 * Worker start: when remote runtimes are in use and packages are configured, start loading their
 * indexes so the first Settings check or install does not wait on the download.
 */
export async function warmRemoteAgentRuntimePackageIndexes(): Promise<void> {
    const usage = await agentRuntimeUsage(undefined, process.env, { published: async () => undefined });
    const remote = usage.runtimes.filter(isRemoteAgentRuntime);
    if (remote.length === 0) return;
    const { getConfig } = await import('../../config/configStore.js');
    const state = await getConfig<{ packages?: unknown } | null>(AGENT_RUNTIME_PACKAGES_CONFIG_KEY, null);
    if (normalizeAgentRuntimePackageList(state?.packages).length === 0) return;
    warmAgentRuntimePackageIndexes(await Promise.all(remote.map(remoteRuntimePackageBase)));
}
