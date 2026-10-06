import { db, executeWithNetworkPolicy, getStateManager, loadInstanceNetworkPolicy, networkEgressReportFromError, resolveNetworkPolicy } from '@propr/core';
import type { NetworkEgressReport, ResolvedNetworkPolicy, ResolvedRepositoryWorkflow } from '@propr/core';
import type { Logger } from 'pino';

/** The `network.egress` timeline event summarising one run's network policy. */
export function networkEgressEvent(report: NetworkEgressReport): { reason: string; metadata: Record<string, unknown> } {
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    const deniedHosts = report.deniedHosts.length + report.omittedDeniedHosts;
    let reason: string;
    if (report.mode === 'open') reason = 'Open network';
    else if (report.refusals?.length) reason = `Restricted network enforced: refused ${[...new Set(report.refusals.map(entry => entry.agentType))].join(', ')}`;
    else if (report.restrictedContainers === 0 && report.fallbacks.length) {
        reason = `Restricted network unavailable for ${[...new Set(report.fallbacks.map(entry => entry.agentType))].join(', ')}; ran with open network`;
    } else if (report.deniedConnections) reason = `Restricted network: denied ${plural(report.deniedConnections, 'connection')} to ${plural(deniedHosts, 'host')}`;
    else reason = 'Restricted network: no connections denied';
    return { reason, metadata: { event: 'network.egress', networkEgress: report } };
}

/** An open run without any policy note says nothing new, so it adds no event. */
export function shouldRecordNetworkEgress(report: NetworkEgressReport): boolean {
    return report.mode === 'restricted' || !!report.note || report.source === 'workflow';
}

export async function recordNetworkEgressEvent(taskId: string, report: NetworkEgressReport, correlatedLogger: Pick<Logger, 'warn'>): Promise<void> {
    if (!shouldRecordNetworkEgress(report)) return;
    try {
        const task = await db('tasks').where({ task_id: taskId }).first('task_id');
        if (!task) return;
        const current = await getStateManager().getTaskState(taskId);
        const event = networkEgressEvent(report);
        await db('task_history').insert({
            task_id: taskId,
            // Written while the run is still in progress; it must not read as a lifecycle change.
            state: current?.state ?? 'claude_execution',
            timestamp: new Date().toISOString(),
            reason: event.reason,
            metadata: JSON.stringify(event.metadata),
        });
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message, networkEgress: report }, 'Could not record network egress timeline event');
    }
}

export async function resolveRunNetworkPolicy(workflow?: ResolvedRepositoryWorkflow): Promise<ResolvedNetworkPolicy> {
    return resolveNetworkPolicy(await loadInstanceNetworkPolicy(), workflow?.config.network);
}

/**
 * Runs one execution under its network policy and records the aggregated
 * result (mode, fallbacks and every denied host) once the containers are gone,
 * whether the execution succeeded or failed.
 */
export async function runWithNetworkPolicy<T>(options: {
    workflow?: ResolvedRepositoryWorkflow; taskId: string; correlatedLogger: Pick<Logger, 'warn'>;
    record?: typeof recordNetworkEgressEvent;
    resolvePolicy?: typeof resolveRunNetworkPolicy;
}, execute: () => Promise<T>): Promise<T> {
    const policy = await (options.resolvePolicy ?? resolveRunNetworkPolicy)(options.workflow);
    const record = options.record ?? recordNetworkEgressEvent;
    try {
        const { result, report } = await executeWithNetworkPolicy(policy, execute);
        await record(options.taskId, report, options.correlatedLogger);
        return result;
    } catch (error) {
        const report = networkEgressReportFromError(error);
        if (report) await record(options.taskId, report, options.correlatedLogger);
        throw error;
    }
}
