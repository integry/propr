import 'dotenv/config';
import type { CommentPayload, CommentEventType } from '@gitfix/core';
import { loadSettingsFromConfig } from './daemon/configLoader.js';
import { resetQueues, resetIssueLabels } from './daemon/queueReset.js';
import { processDetectedIssue, fetchIssuesForRepo } from './daemon/issueDetection.js';
import type { DetectedIssue } from './daemon/issueDetection.js';
declare function pollForIssues(): Promise<DetectedIssue[]>;
interface DaemonOptions {
    reset?: boolean;
}
declare function startDaemon(options?: DaemonOptions): Promise<void>;
declare const processCommentEventWrapper: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => Promise<void>;
declare const handleCommentDeletedWrapper: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => Promise<void>;
declare const handleCommentEditedWrapper: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => Promise<void>;
export { fetchIssuesForRepo, pollForIssues, startDaemon, resetQueues, resetIssueLabels, processDetectedIssue, loadSettingsFromConfig, processCommentEventWrapper as processCommentEvent, handleCommentDeletedWrapper as handleCommentDeleted, handleCommentEditedWrapper as handleCommentEdited };
