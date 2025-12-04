import logger from '../utils/logger.js'; 

let processDetectedIssue;
let processCommentEvent;
let handleCommentDeleted;
let handleCommentEdited;

export async function initializeWebhookHandler(issueProcessor, commentProcessor, commentDeletedHandler, commentEditedHandler) {
    processDetectedIssue = issueProcessor;
    processCommentEvent = commentProcessor;
    handleCommentDeleted = commentDeletedHandler;
    handleCommentEdited = commentEditedHandler;
    logger.info('Webhook handler initialized');
}

export async function processWebhookEvent(payload, eventType, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    if (!processDetectedIssue || !processCommentEvent || !handleCommentDeleted || !handleCommentEdited) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
    }

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
                    createdAt: payload.issue.created_at,
                    updatedAt: payload.issue.updated_at
                };
                
                await processDetectedIssue(issue, correlationId);
            }
            break;
            
        case 'issue_comment':
            if (payload.action === 'created' && payload.issue.pull_request) {
                await processCommentEvent(payload, 'issue_comment', correlationId);
            } else if (payload.action === 'deleted' && payload.issue.pull_request) {
                await handleCommentDeleted(payload, 'issue_comment', correlationId);
            } else if (payload.action === 'edited' && payload.issue.pull_request) {
                await handleCommentEdited(payload, 'issue_comment', correlationId);
            }
            break;

        case 'pull_request_review_comment':
            if (payload.action === 'created') {
                await processCommentEvent(payload, 'pull_request_review_comment', correlationId);
            } else if (payload.action === 'deleted') {
                await handleCommentDeleted(payload, 'pull_request_review_comment', correlationId);
            } else if (payload.action === 'edited') {
                await handleCommentEdited(payload, 'pull_request_review_comment', correlationId);
            }
            break;
            
        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}
