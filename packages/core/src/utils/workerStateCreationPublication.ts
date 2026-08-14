import { db } from '../db/connection.js';
import { getEventPublisher } from './eventPublisher.js';
import logger from './logger.js';
import { TaskStates, type TaskStateData } from './workerStateManager.types.js';

export async function publishCreatedTaskState(state: TaskStateData): Promise<void> {
    const { issueRef, taskId } = state;
    const correlatedLogger = logger.withCorrelation(state.correlationId);
    correlatedLogger.info({
        taskId,
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        state: TaskStates.PENDING,
    }, 'Task state created');
    try {
        const repoOwner = issueRef.repoOwner ?? 'unknown';
        const repoName = issueRef.repoName ?? 'unknown';
        const repository = `${repoOwner}/${repoName}`;
        await db('tasks').insert({
            task_id: taskId,
            job_id: typeof issueRef.jobId === 'string' ? issueRef.jobId : null,
            correlation_id: state.correlationId,
            repository,
            issue_number: issueRef.number,
            task_type: issueRef.type ?? 'issue',
            model_name: issueRef.modelName ?? null,
            created_at: state.createdAt,
            initial_job_data: JSON.stringify(issueRef),
        }).onConflict('task_id').ignore();
        await db('task_history').insert({
            task_id: taskId,
            state: TaskStates.PENDING,
            timestamp: state.createdAt,
            reason: 'Task created',
            metadata: JSON.stringify({}),
        });
        correlatedLogger.debug({ taskId }, 'Task state persisted to database');
        await getEventPublisher().publishTaskUpdate({
            taskId,
            state: TaskStates.PENDING,
            repository,
            issueNumber: issueRef.number,
            timestamp: state.updatedAt,
            version: state.version,
        });
    } catch (error) {
        correlatedLogger.error({
            error: (error as Error).message,
            taskId,
        }, 'Failed to persist task state to database');
    }
}
