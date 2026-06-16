import { test } from 'node:test';
import assert from 'node:assert';
import { isAuthorizedIssueTriggerActor } from '../packages/core/src/daemon/issueTriggerAuthorization.js';

function withEnv(
    values: { GITHUB_USER_WHITELIST?: string; GITHUB_BOT_USERNAME?: string },
    fn: () => void
): void {
    const previousWhitelist = process.env.GITHUB_USER_WHITELIST;
    const previousBotUsername = process.env.GITHUB_BOT_USERNAME;

    if (values.GITHUB_USER_WHITELIST === undefined) {
        delete process.env.GITHUB_USER_WHITELIST;
    } else {
        process.env.GITHUB_USER_WHITELIST = values.GITHUB_USER_WHITELIST;
    }

    if (values.GITHUB_BOT_USERNAME === undefined) {
        delete process.env.GITHUB_BOT_USERNAME;
    } else {
        process.env.GITHUB_BOT_USERNAME = values.GITHUB_BOT_USERNAME;
    }

    try {
        fn();
    } finally {
        if (previousWhitelist === undefined) {
            delete process.env.GITHUB_USER_WHITELIST;
        } else {
            process.env.GITHUB_USER_WHITELIST = previousWhitelist;
        }

        if (previousBotUsername === undefined) {
            delete process.env.GITHUB_BOT_USERNAME;
        } else {
            process.env.GITHUB_BOT_USERNAME = previousBotUsername;
        }
    }
}

test('issue trigger authorization allows configured app bot even when whitelist is gated', () => {
    withEnv({ GITHUB_USER_WHITELIST: 'integry,github-actions[bot]', GITHUB_BOT_USERNAME: 'propr-dev[bot]' }, () => {
        assert.equal(isAuthorizedIssueTriggerActor('propr-dev[bot]'), true);
        assert.equal(isAuthorizedIssueTriggerActor('PROPR-DEV[bot]'), true);
    });
});

test('issue trigger authorization still rejects other non-whitelisted actors', () => {
    withEnv({ GITHUB_USER_WHITELIST: 'integry,github-actions[bot]', GITHUB_BOT_USERNAME: 'propr-dev[bot]' }, () => {
        assert.equal(isAuthorizedIssueTriggerActor('mallory'), false);
        assert.equal(isAuthorizedIssueTriggerActor('propr-dev'), false);
        assert.equal(isAuthorizedIssueTriggerActor('other-app[bot]'), false);
        assert.equal(isAuthorizedIssueTriggerActor(undefined), false);
    });
});

test('issue trigger authorization preserves normal whitelist behavior', () => {
    withEnv({ GITHUB_USER_WHITELIST: 'integry,github-actions[bot]', GITHUB_BOT_USERNAME: 'propr-dev[bot]' }, () => {
        assert.equal(isAuthorizedIssueTriggerActor('integry'), true);
        assert.equal(isAuthorizedIssueTriggerActor('github-actions[bot]'), true);
    });
});

test('issue trigger authorization remains open when whitelist is unset', () => {
    withEnv({ GITHUB_BOT_USERNAME: 'propr-dev[bot]' }, () => {
        assert.equal(isAuthorizedIssueTriggerActor('anyone'), true);
        assert.equal(isAuthorizedIssueTriggerActor(undefined), true);
    });
});
