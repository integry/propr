import {
    type JsonObject,
    type NotificationSourceActivityStatus
} from '@propr/shared';
import type {
    SourceActivityRow,
    TaskProjectionContext
} from './notificationProjectionStore.js';

export function taskActivityStatus(state: string): NotificationSourceActivityStatus {
    switch (state.toLowerCase()) {
        case 'pending':
        case 'queued':
        case 'waiting':
        case 'delayed':
            return 'queued';
        case 'completed':
        case 'complete':
        case 'succeeded':
            return 'completed';
        case 'failed':
        case 'error':
            return 'failed';
        case 'cancelled':
        case 'canceled':
            return 'cancelled';
        default:
            return 'processing';
    }
}

export function indexingActivityStatus(phase: string): NotificationSourceActivityStatus {
    switch (phase.toLowerCase()) {
        case 'completed': return 'completed';
        case 'failed': return 'failed';
        case 'idle': return 'cancelled';
        default: return 'processing';
    }
}

export function safeTaskMetadata(
    context: TaskProjectionContext,
    state: string,
    timestamp: string
): JsonObject {
    return {
        transitionState: state,
        transitionAt: timestamp,
        ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
        ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber }),
        ...(context.commandMode === undefined ? {} : { commandMode: context.commandMode })
    };
}

export function taskBodySubject(context: TaskProjectionContext): string {
    return context.issueNumber === undefined ? 'A task' : `Task for issue #${context.issueNumber}`;
}

export function safePullRequestUrl(context: TaskProjectionContext): string | undefined {
    if (context.prNumber === undefined) return undefined;
    const canonical = `https://github.com/${context.repository}/pull/${context.prNumber}`;
    const candidate = context.prUrl ?? canonical;
    try {
        const url = new URL(candidate);
        const expectedPath = `/${context.repository}/pull/${context.prNumber}`;
        if (
            url.protocol !== 'https:'
            || url.hostname !== 'github.com'
            || url.port !== ''
            || url.username
            || url.password
            || decodeURIComponent(url.pathname).replace(/\/$/, '') !== expectedPath
        ) return canonical;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return canonical;
    }
}

export function parseActivityMetadata(row: SourceActivityRow): JsonObject {
    if (!row.metadata_json) return {};
    try {
        const parsed: unknown = JSON.parse(row.metadata_json);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as JsonObject
            : {};
    } catch {
        return {};
    }
}

export function taskTarget(context: TaskProjectionContext) {
    return {
        type: 'task' as const,
        repository: context.repository,
        taskId: context.taskId,
        ...(context.issueNumber === undefined ? {} : { issueNumber: context.issueNumber }),
        ...(context.prNumber === undefined ? {} : { prNumber: context.prNumber })
    };
}

export function taskAction(taskId: string) {
    return {
        type: 'navigate' as const,
        label: 'View task',
        href: `/tasks/${encodeURIComponent(taskId)}`
    };
}
