import { test } from 'node:test';
import assert from 'node:assert';
import { isGithubUserWhitelisted, getGithubUserWhitelist } from '../packages/core/src/utils/userWhitelist.js';

function withWhitelist(value: string | undefined, fn: () => void): void {
    const prev = process.env.GITHUB_USER_WHITELIST;
    if (value === undefined) {
        delete process.env.GITHUB_USER_WHITELIST;
    } else {
        process.env.GITHUB_USER_WHITELIST = value;
    }
    try {
        fn();
    } finally {
        if (prev === undefined) {
            delete process.env.GITHUB_USER_WHITELIST;
        } else {
            process.env.GITHUB_USER_WHITELIST = prev;
        }
    }
}

test('empty whitelist allows any trigger actor', () => {
    withWhitelist(undefined, () => {
        assert.equal(isGithubUserWhitelisted('anyone'), true);
        assert.equal(isGithubUserWhitelisted(undefined), true);
    });
});

test('configured whitelist gates the trigger actor (case-insensitive, [bot]-tolerant)', () => {
    withWhitelist('Alice, propr-bot', () => {
        assert.deepEqual(getGithubUserWhitelist(), ['Alice', 'propr-bot']);
        assert.equal(isGithubUserWhitelisted('alice'), true);
        assert.equal(isGithubUserWhitelisted('ALICE'), true);
        assert.equal(isGithubUserWhitelisted('propr-bot[bot]'), true); // trailing [bot] tolerated
        assert.equal(isGithubUserWhitelisted('mallory'), false);
        assert.equal(isGithubUserWhitelisted(undefined), false); // unknown actor blocked when gated
    });
});
