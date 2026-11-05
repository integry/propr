/** Structural guards for the webhook payload shapes the handler dispatches on. */
import type {
    IssuesEvent, IssuesLabeledEvent,
    IssueCommentEvent, IssueCommentCreatedEvent, IssueCommentDeletedEvent, IssueCommentEditedEvent,
    PullRequestReviewCommentEvent, PullRequestReviewCommentCreatedEvent,
    PullRequestReviewCommentDeletedEvent, PullRequestReviewCommentEditedEvent,
    PullRequestEvent, CheckRunEvent, CheckSuiteEvent, PushEvent,
} from '@octokit/webhooks-types';
import type { StatusEventPayload } from './checkRunHandler.js';

export function getRepositoryFullName(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null || !('repository' in payload)) return null;
    const repository = (payload as { repository?: unknown }).repository;
    if (typeof repository !== 'object' || repository === null || !('full_name' in repository)) return null;
    const fullName = (repository as { full_name?: unknown }).full_name;
    return typeof fullName === 'string' && fullName.trim() ? fullName.trim() : null;
}

export function isIssuesEvent(payload: unknown): payload is IssuesEvent {
    return typeof payload === 'object' && payload !== null && 'issue' in payload && 'action' in payload && !('comment' in payload);
}

export const isIssuesLabeledEvent = (payload: IssuesEvent): payload is IssuesLabeledEvent => payload.action === 'labeled';

export function isIssueCommentEvent(payload: unknown): payload is IssueCommentEvent {
    return typeof payload === 'object' && payload !== null && 'issue' in payload && 'comment' in payload && 'action' in payload;
}

export const isIssueCommentCreatedEvent = (payload: IssueCommentEvent): payload is IssueCommentCreatedEvent => payload.action === 'created';
export const isIssueCommentDeletedEvent = (payload: IssueCommentEvent): payload is IssueCommentDeletedEvent => payload.action === 'deleted';
export const isIssueCommentEditedEvent = (payload: IssueCommentEvent): payload is IssueCommentEditedEvent => payload.action === 'edited';

export function isPullRequestReviewCommentEvent(payload: unknown): payload is PullRequestReviewCommentEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'comment' in payload && 'action' in payload;
}

export const isPullRequestReviewCommentCreatedEvent = (payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentCreatedEvent => payload.action === 'created';
export const isPullRequestReviewCommentDeletedEvent = (payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentDeletedEvent => payload.action === 'deleted';
export const isPullRequestReviewCommentEditedEvent = (payload: PullRequestReviewCommentEvent): payload is PullRequestReviewCommentEditedEvent => payload.action === 'edited';

export function isPullRequestEvent(payload: unknown): payload is PullRequestEvent {
    return typeof payload === 'object' && payload !== null && 'pull_request' in payload && 'action' in payload && !('comment' in payload);
}

export function isCheckRunEvent(payload: unknown): payload is CheckRunEvent {
    return typeof payload === 'object' && payload !== null && 'check_run' in payload && 'action' in payload;
}

export function isCheckSuiteEvent(payload: unknown): payload is CheckSuiteEvent {
    return typeof payload === 'object' && payload !== null && 'check_suite' in payload && 'action' in payload && !('check_run' in payload);
}

export function isPushEvent(payload: unknown): payload is PushEvent {
    return typeof payload === 'object' && payload !== null && 'ref' in payload && 'commits' in payload && !('action' in payload);
}

export function isStatusEvent(payload: unknown): payload is StatusEventPayload {
    return typeof payload === 'object' && payload !== null && 'sha' in payload && 'state' in payload && !('action' in payload) && !('commits' in payload);
}
