import { getEventPublisher } from './eventPublisher.js';
import logger from './logger.js';
import type { IssueRef, TaskState, TaskStateData } from './workerStateManager.types.js';

export async function publishIssueRefUpdate(
    state: TaskStateData,
    issueRefPatch: Partial<IssueRef>,
): Promise<void> {
    const taskId = state.taskId;
    const updatedFields = Object.keys(issueRefPatch);
    const correlatedLogger = logger.withCorrelation(state.correlationId);
    correlatedLogger.info({
        taskId,
        issueNumber: state.issueRef.number,
        repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
        updatedFields,
    }, 'Task issue reference updated');

    try {
        await getEventPublisher().publishTaskUpdate({
            taskId,
            state: state.state,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            issueNumber: state.issueRef.number,
            version: state.version,
            updatedAt: state.updatedAt,
            metadata: { issueRefUpdated: true, updatedFields },
        });
    } catch (error) {
        correlatedLogger.warn(
            { error: (error as Error).message, taskId },
            'Failed to publish issue reference update event',
        );
    }
}

export async function publishHistoryMetadataUpdate(
    state: TaskStateData,
    historyState: TaskState,
    metadata: Record<string, unknown>,
): Promise<void> {
    const taskId = state.taskId;
    const correlatedLogger = logger.withCorrelation(state.correlationId);
    correlatedLogger.debug({ taskId, historyState, metadata }, 'Updated history metadata');

    try {
        await getEventPublisher().publishTaskUpdate({
            taskId,
            state: state.state,
            repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
            issueNumber: state.issueRef.number,
            version: state.version,
            updatedAt: state.updatedAt,
            metadata: { metadataUpdate: true, updatedFields: Object.keys(metadata) },
        });
    } catch (error) {
        correlatedLogger.warn(
            { error: (error as Error).message, taskId },
            'Failed to publish metadata update event',
        );
    }
}
