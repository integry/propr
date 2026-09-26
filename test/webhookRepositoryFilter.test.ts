import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const {
    initializeWebhookHandler,
    processWebhookEvent,
} = await import('../packages/core/src/webhook/webhookHandler.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

after(async () => {
    await closeConnection();
});

function handlerOptions(repositoryFilter?: (repository: string) => boolean) {
    return {
        issueProcessor: mock.fn(async () => {}),
        commentProcessor: mock.fn(async () => {}),
        commentDeletedHandler: mock.fn(async () => {}),
        commentEditedHandler: mock.fn(async () => {}),
        repositoryFilter,
    };
}

test('webhook processing rejects unmonitored repositories before side effects', async () => {
    const options = handlerOptions(repository => repository.toLowerCase() === 'owner/allowed');
    await initializeWebhookHandler(options);

    const result = await processWebhookEvent({
        repository: { full_name: 'owner/not-allowed' },
        action: 'labeled',
        issue: {},
    }, 'issues', 'repository-filter-test');

    assert.deepEqual(result, { status: 'ignored', reason: 'repository_not_monitored' });
    assert.equal(options.issueProcessor.mock.calls.length, 0);
    assert.equal(options.commentProcessor.mock.calls.length, 0);
});

test('webhook processing keeps normal validation for monitored repositories', async () => {
    await initializeWebhookHandler(handlerOptions(repository => repository === 'owner/allowed'));

    const result = await processWebhookEvent({
        repository: { full_name: 'owner/allowed' },
    }, 'issues', 'repository-filter-allowed-test');

    assert.deepEqual(result, { status: 'ignored', reason: 'unsupported_event' });
});

test('webhook processing fails closed when repository identity is missing', async () => {
    await initializeWebhookHandler(handlerOptions(() => true));

    const result = await processWebhookEvent({}, 'issues', 'repository-filter-missing-test');

    assert.deepEqual(result, { status: 'ignored', reason: 'repository_missing' });
});
