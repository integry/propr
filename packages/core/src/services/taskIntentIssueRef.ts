import type { IssueRef } from '../utils/workerStateManager.types.js';

/** The issue or pull request a task acts on. */
export interface IntentTarget {
    repoOwner: string;
    repoName: string;
    number: number;
    kind: 'issue' | 'pr';
    triggeringLabel?: string;
}

/** The job data fields a task keeps in its state; `requestedBy` names a plugin that created the task. */
export const TASK_INTENT_CARRIED_FIELDS = ['triggeringLabel', 'modelName', 'agentAlias', 'correlationId', 'requestedBy'] as const;

/** Persist only the small reference needed for intent, display and task identity. */
export function taskIntentIssueRef(data: object, target: IntentTarget): IssueRef {
    const fields = data as Record<string, unknown>;
    return {
        number: target.number, repoOwner: target.repoOwner, repoName: target.repoName,
        type: target.kind === 'pr' ? 'pr-comment' : 'issue',
        ...(target.kind === 'pr' ? { pullRequestNumber: target.number } : {}),
        ...Object.fromEntries(TASK_INTENT_CARRIED_FIELDS.flatMap(key =>
            typeof fields[key] === 'string' ? [[key, fields[key]]] : [])),
    };
}
