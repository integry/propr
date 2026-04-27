import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { buildAuthPayload, generateAuthToken, verifyAuthToken, AUTH_TOKEN_MAX_AGE_MS, AUTH_TOKEN_MAX_CLOCK_SKEW_MS, getUserWhitelist } from '@propr/core';
import type { SystemTaskJobData } from '@propr/core';

/**
 * Test suite for system task authorization logic.
 *
 * Covers:
 * - buildAuthPayload canonical format
 * - HMAC token generation and verification round-trip
 * - Whitelist rejection (empty whitelist = fail-closed, user not in list)
 * - Missing/invalid auth token rejection
 * - Expired token rejection (replay resistance)
 * - Tampered payload detection (commitHash swap, etc.)
 * - Legitimate request success
 *
 * These tests import the real production functions from @propr/core
 * so they exercise the actual code path used at runtime.
 */

const TEST_SECRET = 'test-secret-key-for-unit-tests';

const originalEnv: Record<string, string | undefined> = {};

function saveAndSetEnv(key: string, value: string | undefined): void {
    if (!(key in originalEnv)) {
        originalEnv[key] = process.env[key];
    }
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

function restoreEnv(): void {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    // Clear the snapshot so subsequent suites start fresh
    for (const key of Object.keys(originalEnv)) {
        delete originalEnv[key];
    }
}

function makeJobData(overrides: Partial<SystemTaskJobData> = {}): SystemTaskJobData {
    return {
        type: 'revert',
        owner: 'testorg',
        repoName: 'testrepo',
        prNumber: 42,
        requestingUser: 'alice',
        commitHash: 'abc1234def5678',
        targetCommentId: 99999,
        prBranch: 'feature-branch',
        authTimestamp: Date.now(),
        authToken: '',
        correlationId: 'test-correlation',
        ...overrides
    };
}

describe('System Task Authorization', () => {
    beforeEach(() => {
        saveAndSetEnv('SYSTEM_TASK_SECRET', TEST_SECRET);
    });

    afterEach(() => {
        restoreEnv();
    });

    describe('buildAuthPayload', () => {
        test('includes all security-relevant fields in canonical order', () => {
            const data = makeJobData({ authTimestamp: 1700000000000 });
            const payload = buildAuthPayload(data);
            assert.strictEqual(
                payload,
                'revert:testorg:testrepo:42:alice:abc1234def5678:99999:feature-branch:1700000000000'
            );
        });

        test('different commitHash produces different payload', () => {
            const data1 = makeJobData({ commitHash: 'aaa1111' });
            const data2 = makeJobData({ commitHash: 'bbb2222' });
            assert.notStrictEqual(buildAuthPayload(data1), buildAuthPayload(data2));
        });

        test('different targetCommentId produces different payload', () => {
            const data1 = makeJobData({ targetCommentId: 100 });
            const data2 = makeJobData({ targetCommentId: 200 });
            assert.notStrictEqual(buildAuthPayload(data1), buildAuthPayload(data2));
        });

        test('different prBranch produces different payload', () => {
            const data1 = makeJobData({ prBranch: 'branch-a' });
            const data2 = makeJobData({ prBranch: 'branch-b' });
            assert.notStrictEqual(buildAuthPayload(data1), buildAuthPayload(data2));
        });
    });

    describe('HMAC token verification', () => {
        test('valid token is accepted', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, true);
        });

        test('missing SYSTEM_TASK_SECRET rejects', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, undefined);
            assert.strictEqual(result.valid, false);
            assert.ok(result.reason?.includes('not configured'));
        });

        test('wrong secret rejects', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, 'wrong-secret');
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, 'HMAC mismatch');
        });

        test('empty auth token rejects', () => {
            const data = makeJobData({ authToken: '' });
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
        });

        test('malformed (non-hex) auth token rejects', () => {
            const data = makeJobData({ authToken: 'not-a-hex-string!' });
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.ok(result.reason?.includes('malformed'));
        });

        test('wrong-length hex token rejects before HMAC comparison', () => {
            const data = makeJobData({ authToken: 'abcd1234' }); // valid hex but wrong length
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.ok(result.reason?.includes('malformed'));
        });

        test('tampered commitHash invalidates token', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            // Tamper with commitHash after signing
            data.commitHash = 'tampered1234567';
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, 'HMAC mismatch');
        });

        test('tampered targetCommentId invalidates token', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            data.targetCommentId = 11111;
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
        });

        test('tampered prBranch invalidates token', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            data.prBranch = 'evil-branch';
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
        });

        test('tampered requestingUser invalidates token', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            data.requestingUser = 'mallory';
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
        });
    });

    describe('Replay resistance (authTimestamp)', () => {
        test('missing authTimestamp rejects', () => {
            const data = makeJobData();
            data.authToken = generateAuthToken(data, TEST_SECRET);
            (data as Record<string, unknown>).authTimestamp = undefined;
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.ok(result.reason?.includes('authTimestamp'));
        });

        test('expired token (beyond AUTH_TOKEN_MAX_AGE_MS) rejects', () => {
            const data = makeJobData({
                authTimestamp: Date.now() - AUTH_TOKEN_MAX_AGE_MS - 60 * 1000 // 1 minute past expiry
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.ok(result.reason?.includes('expired'));
        });

        test('recent token (within AUTH_TOKEN_MAX_AGE_MS) is accepted', () => {
            const data = makeJobData({
                authTimestamp: Date.now() - 2 * 60 * 1000 // 2 minutes ago
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, true);
        });

        test('future-dated token (beyond clock-skew allowance) rejects', () => {
            const data = makeJobData({
                authTimestamp: Date.now() + AUTH_TOKEN_MAX_CLOCK_SKEW_MS + 60 * 1000 // 1 minute beyond skew
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.ok(result.reason?.includes('future'));
        });

        test('token within clock-skew allowance is accepted', () => {
            const data = makeJobData({
                authTimestamp: Date.now() + 30 * 1000 // 30 seconds in the future (within 1 min skew)
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('Fork PR payload (headRepoOwner/headRepoName)', () => {
        test('payload without headRepoOwner/headRepoName is backward-compatible', () => {
            const data = makeJobData({ authTimestamp: 1700000000000 });
            const payload = buildAuthPayload(data);
            assert.strictEqual(
                payload,
                'revert:testorg:testrepo:42:alice:abc1234def5678:99999:feature-branch:1700000000000'
            );
        });

        test('payload with headRepoOwner/headRepoName includes fork identity', () => {
            const data = makeJobData({
                authTimestamp: 1700000000000,
                headRepoOwner: 'fork-user',
                headRepoName: 'forked-repo'
            });
            const payload = buildAuthPayload(data);
            assert.strictEqual(
                payload,
                'revert:testorg:testrepo:42:alice:abc1234def5678:99999:feature-branch:1700000000000:fork-user:forked-repo'
            );
        });

        test('token signed with headRepoOwner/headRepoName is valid', () => {
            const data = makeJobData({
                headRepoOwner: 'fork-user',
                headRepoName: 'forked-repo'
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, true);
        });

        test('tampered headRepoOwner invalidates token', () => {
            const data = makeJobData({
                headRepoOwner: 'fork-user',
                headRepoName: 'forked-repo'
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            data.headRepoOwner = 'evil-user';
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, 'HMAC mismatch');
        });

        test('tampered headRepoName invalidates token', () => {
            const data = makeJobData({
                headRepoOwner: 'fork-user',
                headRepoName: 'forked-repo'
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            data.headRepoName = 'evil-repo';
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, 'HMAC mismatch');
        });

        test('adding headRepoOwner/headRepoName after signing invalidates token', () => {
            const data = makeJobData(); // no fork fields
            data.authToken = generateAuthToken(data, TEST_SECRET);
            // Attacker tries to add fork fields after signing
            data.headRepoOwner = 'evil-user';
            data.headRepoName = 'evil-repo';
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, 'HMAC mismatch');
        });

        test('removing headRepoOwner/headRepoName after signing invalidates token', () => {
            const data = makeJobData({
                headRepoOwner: 'fork-user',
                headRepoName: 'forked-repo'
            });
            data.authToken = generateAuthToken(data, TEST_SECRET);
            // Attacker strips fork fields to redirect to base repo
            delete data.headRepoOwner;
            delete data.headRepoName;
            const result = verifyAuthToken(data, TEST_SECRET);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, 'HMAC mismatch');
        });
    });

    describe('Whitelist (fail-closed) — exercises getUserWhitelist()', () => {
        test('empty GITHUB_USER_WHITELIST returns empty array (fail-closed)', () => {
            saveAndSetEnv('GITHUB_USER_WHITELIST', '');
            const whitelist = getUserWhitelist();
            assert.strictEqual(whitelist.length, 0, 'Empty env should return empty whitelist');
        });

        test('configured whitelist returns expected users', () => {
            saveAndSetEnv('GITHUB_USER_WHITELIST', 'bob,charlie');
            const whitelist = getUserWhitelist();
            assert.ok(whitelist.includes('bob'));
            assert.ok(whitelist.includes('charlie'));
            assert.ok(!whitelist.includes('alice'), 'alice should not be in whitelist');
        });

        test('user in whitelist passes includes check', () => {
            saveAndSetEnv('GITHUB_USER_WHITELIST', 'alice,bob');
            const whitelist = getUserWhitelist();
            assert.strictEqual(whitelist.includes('alice'), true);
        });

        test('whitelist check is case-sensitive', () => {
            saveAndSetEnv('GITHUB_USER_WHITELIST', 'Alice');
            const whitelist = getUserWhitelist();
            assert.strictEqual(whitelist.includes('alice'), false);
            assert.strictEqual(whitelist.includes('Alice'), true);
        });
    });
});
