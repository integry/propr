import { test } from 'node:test';
import assert from 'node:assert';
import { isUserWhitelisted, getUserWhitelist } from '../packages/api/userWhitelist.js';

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

test('empty whitelist allows everyone (open access)', () => {
    withWhitelist(undefined, () => {
        assert.equal(isUserWhitelisted('anyone'), true);
        assert.equal(isUserWhitelisted(undefined), true);
    });
    withWhitelist('  ', () => {
        assert.equal(isUserWhitelisted('anyone'), true);
    });
});

test('non-empty whitelist gates by membership (case-insensitive)', () => {
    withWhitelist('Alice, bob', () => {
        assert.deepEqual(getUserWhitelist(), ['Alice', 'bob']);
        assert.equal(isUserWhitelisted('alice'), true);
        assert.equal(isUserWhitelisted('ALICE'), true);
        assert.equal(isUserWhitelisted('bob'), true);
        assert.equal(isUserWhitelisted('carol'), false);
        assert.equal(isUserWhitelisted(undefined), false);
        assert.equal(isUserWhitelisted(''), false);
    });
});
