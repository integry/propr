import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { filterCommentByAuthor } from '../utils/commentFilters.js';

let processDetectedIssue;
let processCommentEvent;

export async function initializeWebhookHandler(issueProcessor, commentProcessor) {
    processDetectedIssue = issueProcessor;
    processCommentEvent = commentProcessor;
    logger.info('Webhook handler initialized');
}

export async function processWebhookEvent(payload, eventType, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    if (!processDetectedIssue || !processCommentEvent) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
    }
    
    const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
    const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

    switch (eventType) {
        case 'issues':
            if (payload.action === 'labeled') {
                const [owner, repo] = payload.repository.full_name.split('/');
                
                const issue = {
                    id: payload.issue.id,
                    number: payload.issue.number,
                    title: payload.issue.title,
                    url: payload.issue.html_url,
                    repoOwner: owner,
                    repoName: repo,
                    labels: payload.issue.labels.map(l => l.name),
                    targetModels: [],
                    createdAt: payload.issue.created_at,
                    updatedAt: payload.issue.updated_at
                };
                
                const identifiedModels = [];
                const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
                
                for (const label of payload.issue.labels) {
                    const match = label.name.match(modelLabelRegex);
                    if (match && match[1]) {
                        const resolvedModel = resolveModelAlias(match[1]);
                        identifiedModels.push(resolvedModel);
                    }
                }
                
                issue.targetModels = identifiedModels.length > 0 ? identifiedModels : [DEFAULT_MODEL_NAME];
                
                await processDetectedIssue(issue, correlationId);
            }
            break;
            
        case 'issue_comment':
            if (payload.action === 'created' && payload.issue.pull_request) {
                const commentAuthor = payload.comment.user.login;
                const filterResult = filterCommentByAuthor(commentAuthor, correlationId);

                if (filterResult.shouldFilter) {
                    return; // Skip this comment
                }

                await processCommentEvent(payload, 'issue_comment', correlationId);
            }
            break;

        case 'pull_request_review_comment':
            if (payload.action === 'created') {
                const commentAuthor = payload.comment.user.login;
                const filterResult = filterCommentByAuthor(commentAuthor, correlationId);

                if (filterResult.shouldFilter) {
                    return; // Skip this comment
                }

                await processCommentEvent(payload, 'pull_request_review_comment', correlationId);
            }
            break;
            
        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}
