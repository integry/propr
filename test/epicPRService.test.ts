import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Unit tests for generateEpicBranchName and related functions
 *
 * These tests validate:
 * - Plan name truncation to max 2 words
 * - Random suffix generation (3 alphanumeric characters)
 * - Valid git branch name format
 * - EPIC_BRANCH_PATTERN regex matching
 * - Issue ID extraction
 */

// Import the module under test directly (no mocking needed for these pure functions)
import {
    generateEpicBranchName,
    isEpicBranch,
    extractFirstIssueIdFromEpicBranch,
    EPIC_BRANCH_PATTERN
} from '../packages/core/src/services/epicPRService.js';

describe('generateEpicBranchName', () => {

    describe('basic functionality', () => {

        test('generates branch name with correct format structure', () => {
            const result = generateEpicBranchName(123, 'Test Plan Name');

            // Should match: {id}-epic-{word1}-{word2}-{3-char-suffix}
            assert.match(result, /^123-epic-test-plan-[a-z0-9]{3}$/);
        });

        test('includes issue ID at the beginning', () => {
            const result = generateEpicBranchName(999, 'Some Plan');

            assert.ok(result.startsWith('999-epic-'),
                `Branch name should start with issue ID: ${result}`);
        });

        test('includes epic keyword in branch name', () => {
            const result = generateEpicBranchName(1, 'Plan');

            assert.ok(result.includes('-epic-'),
                `Branch name should contain '-epic-': ${result}`);
        });

        test('generates 3-character alphanumeric random suffix', () => {
            const result = generateEpicBranchName(1, 'Plan Name');

            // Match the suffix at the end (3 alphanumeric chars)
            assert.match(result, /-[a-z0-9]{3}$/,
                `Branch name should end with 3-char suffix: ${result}`);
        });

        test('generates unique suffixes on multiple calls', () => {
            const results = new Set<string>();
            // Generate multiple branch names and check uniqueness
            // (statistically very unlikely to collide with 36^3 = 46656 possibilities)
            for (let i = 0; i < 10; i++) {
                results.add(generateEpicBranchName(1, 'Test'));
            }
            // With high probability, we should have multiple unique results
            assert.ok(results.size > 1,
                'Multiple generations should produce different suffixes');
        });

    });

    describe('plan name truncation', () => {

        test('truncates plan name to maximum 2 words', () => {
            const result = generateEpicBranchName(1, 'First Second Third Fourth Fifth');

            // Should only contain first two words before the random suffix
            assert.match(result, /^1-epic-first-second-[a-z0-9]{3}$/,
                `Should truncate to 2 words: ${result}`);
        });

        test('converts plan name to lowercase', () => {
            const result = generateEpicBranchName(1, 'UPPERCASE WORDS');

            assert.match(result, /^1-epic-uppercase-words-[a-z0-9]{3}$/,
                `Should convert to lowercase: ${result}`);
        });

        test('removes special characters from plan name', () => {
            const result = generateEpicBranchName(1, 'Hello! @World# $Test%');

            // Only alphanumeric words should remain
            assert.match(result, /^1-epic-hello-world-[a-z0-9]{3}$/,
                `Should remove special chars: ${result}`);
        });

        test('handles plan name with only one word by adding branch suffix', () => {
            const result = generateEpicBranchName(1, 'SingleWord');

            assert.match(result, /^1-epic-singleword-branch-[a-z0-9]{3}$/,
                `Single word should get '-branch' suffix: ${result}`);
        });

        test('handles empty plan name by using epic fallback', () => {
            const result = generateEpicBranchName(1, '');

            // Empty plan name triggers fallback to "epic" (single word)
            // Format becomes: {id}-epic-epic-{suffix}
            assert.match(result, /^1-epic-epic-[a-z0-9]{3}$/,
                `Empty plan name should fallback to 'epic': ${result}`);
            // Note: This format won't match EPIC_BRANCH_PATTERN (expects 2 words)
        });

        test('handles plan name with only special characters by using epic fallback', () => {
            const result = generateEpicBranchName(1, '!@#$%^&*()');

            // Special-chars-only triggers fallback to "epic" (single word)
            assert.match(result, /^1-epic-epic-[a-z0-9]{3}$/,
                `Special chars only should fallback to 'epic': ${result}`);
        });

        test('handles plan name with numbers', () => {
            const result = generateEpicBranchName(1, 'Version 2 Release');

            assert.match(result, /^1-epic-version-2-[a-z0-9]{3}$/,
                `Should preserve numbers in words: ${result}`);
        });

        test('handles plan name with mixed alphanumeric', () => {
            const result = generateEpicBranchName(42, 'Feature123 Release456');

            assert.match(result, /^42-epic-feature123-release456-[a-z0-9]{3}$/,
                `Should handle mixed alphanumeric: ${result}`);
        });

        test('handles plan name with hyphens', () => {
            const result = generateEpicBranchName(1, 'pre-release feature-set');

            // Hyphens split words, so we get pre, release, feature, set - takes first two
            assert.match(result, /^1-epic-pre-release-[a-z0-9]{3}$/,
                `Hyphens should split words: ${result}`);
        });

        test('handles plan name with underscores', () => {
            const result = generateEpicBranchName(1, 'snake_case naming_convention');

            // Underscores split words
            assert.match(result, /^1-epic-snake-case-[a-z0-9]{3}$/,
                `Underscores should split words: ${result}`);
        });

        test('handles whitespace-only plan name by using epic fallback', () => {
            const result = generateEpicBranchName(1, '   \t\n   ');

            // Whitespace-only triggers fallback to "epic" (single word)
            assert.match(result, /^1-epic-epic-[a-z0-9]{3}$/,
                `Whitespace only should fallback to 'epic': ${result}`);
        });

    });

    describe('random suffix generation', () => {

        test('suffix contains only lowercase letters and numbers', () => {
            const result = generateEpicBranchName(1, 'Test Plan');

            // Extract suffix (last 3 characters)
            const suffix = result.slice(-3);
            assert.match(suffix, /^[a-z0-9]{3}$/,
                `Suffix should be 3 alphanumeric chars: ${suffix}`);
        });

        test('suffix is exactly 3 characters', () => {
            const result = generateEpicBranchName(1, 'Test Plan');
            const suffix = result.slice(-3);

            assert.strictEqual(suffix.length, 3,
                `Suffix should be exactly 3 characters: ${suffix}`);
        });

        test('multiple calls produce different results', () => {
            const suffixes = new Set<string>();
            for (let i = 0; i < 50; i++) {
                const result = generateEpicBranchName(1, 'Test');
                suffixes.add(result.slice(-3));
            }
            // Very high probability of getting at least 2 different suffixes in 50 calls
            assert.ok(suffixes.size >= 2,
                `Should produce varied suffixes, got ${suffixes.size} unique`);
        });

    });

    describe('git branch name validity', () => {

        test('generated branch name is a valid git branch name', () => {
            const result = generateEpicBranchName(100, 'Feature Update');

            // Valid git branch names: no spaces, no special chars except - _ /
            // Must not start with - or end with .lock
            assert.match(result, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
                `Should be valid git branch: ${result}`);
            assert.ok(!result.includes(' '), 'Should not contain spaces');
            assert.ok(!result.includes('..'), 'Should not contain consecutive dots');
            assert.ok(!result.endsWith('.lock'), 'Should not end with .lock');
        });

        test('generated branch name does not contain consecutive dots', () => {
            const result = generateEpicBranchName(1, 'Test..Plan');

            assert.ok(!result.includes('..'),
                `Should not contain consecutive dots: ${result}`);
        });

        test('generated branch name does not start with hyphen', () => {
            const result = generateEpicBranchName(1, '-starts-with-hyphen');

            assert.ok(!result.startsWith('-'),
                `Should not start with hyphen: ${result}`);
        });

        test('matches EPIC_BRANCH_PATTERN regex', () => {
            const result = generateEpicBranchName(800, 'Short Name');

            assert.ok(EPIC_BRANCH_PATTERN.test(result),
                `Branch name "${result}" should match EPIC_BRANCH_PATTERN`);
        });

        test('isEpicBranch returns true for generated branch names', () => {
            const result = generateEpicBranchName(500, 'My Epic Plan');

            assert.strictEqual(isEpicBranch(result), true,
                `isEpicBranch should return true for: ${result}`);
        });

    });

    describe('issue ID extraction', () => {

        test('extractFirstIssueIdFromEpicBranch extracts correct ID', () => {
            const branchName = generateEpicBranchName(12345, 'Test Plan');
            const extractedId = extractFirstIssueIdFromEpicBranch(branchName);

            assert.strictEqual(extractedId, 12345,
                `Should extract ID 12345 from ${branchName}`);
        });

        test('extractFirstIssueIdFromEpicBranch returns null for non-epic branches', () => {
            const extractedId = extractFirstIssueIdFromEpicBranch('feature/some-feature');

            assert.strictEqual(extractedId, null);
        });

        test('round-trip: generate then extract issue ID', () => {
            const issueIds = [1, 100, 9999, 123456];

            for (const issueId of issueIds) {
                const branchName = generateEpicBranchName(issueId, 'Test');
                const extractedId = extractFirstIssueIdFromEpicBranch(branchName);

                assert.strictEqual(extractedId, issueId,
                    `Issue ID ${issueId} should be extractable from branch name ${branchName}`);
            }
        });

    });

    describe('various issue IDs', () => {

        test('handles issue ID of 1', () => {
            const result = generateEpicBranchName(1, 'Test Plan');
            assert.ok(result.startsWith('1-epic-'));
            assert.ok(EPIC_BRANCH_PATTERN.test(result));
        });

        test('handles large issue ID', () => {
            const result = generateEpicBranchName(999999, 'Test Plan');
            assert.ok(result.startsWith('999999-epic-'));
            assert.ok(EPIC_BRANCH_PATTERN.test(result));
        });

        test('handles various issue IDs correctly', () => {
            const ids = [1, 10, 100, 1000, 10000, 100000];
            for (const id of ids) {
                const result = generateEpicBranchName(id, 'Test');
                assert.ok(result.startsWith(`${id}-epic-`),
                    `Should start with ${id}-epic-: ${result}`);
            }
        });

    });

});

describe('isEpicBranch', () => {

    test('returns true for valid epic branch format', () => {
        assert.strictEqual(isEpicBranch('800-epic-short-name-x7y'), true);
    });

    test('returns true for epic branch with numeric words', () => {
        assert.strictEqual(isEpicBranch('123-epic-v2-release-abc'), true);
    });

    test('returns true for epic branch with all numeric suffix', () => {
        assert.strictEqual(isEpicBranch('100-epic-test-plan-999'), true);
    });

    test('returns false for non-epic branches', () => {
        assert.strictEqual(isEpicBranch('feature/my-feature'), false);
        assert.strictEqual(isEpicBranch('main'), false);
        assert.strictEqual(isEpicBranch('develop'), false);
        assert.strictEqual(isEpicBranch('bugfix/fix-something'), false);
    });

    test('returns false for branches with wrong format', () => {
        // Missing epic keyword
        assert.strictEqual(isEpicBranch('800-short-name-x7y'), false,
            'Missing epic keyword');

        // Missing random suffix
        assert.strictEqual(isEpicBranch('800-epic-short-name'), false,
            'Missing random suffix');

        // Wrong suffix length (not 3 chars)
        assert.strictEqual(isEpicBranch('800-epic-short-name-xy'), false,
            'Suffix too short');
        assert.strictEqual(isEpicBranch('800-epic-short-name-xyza'), false,
            'Suffix too long');

        // Missing issue ID
        assert.strictEqual(isEpicBranch('epic-short-name-xyz'), false,
            'Missing issue ID');
    });

    test('returns false for epic branch with uppercase letters', () => {
        assert.strictEqual(isEpicBranch('800-epic-SHORT-name-x7y'), false);
        assert.strictEqual(isEpicBranch('800-EPIC-short-name-x7y'), false);
        assert.strictEqual(isEpicBranch('800-epic-short-name-X7Y'), false);
    });

    test('returns false for branches with special characters', () => {
        assert.strictEqual(isEpicBranch('800-epic-short_name-xyz'), false);
        assert.strictEqual(isEpicBranch('800-epic-short.name-xyz'), false);
        assert.strictEqual(isEpicBranch('800-epic-short/name-xyz'), false);
    });

    test('returns false for empty string', () => {
        assert.strictEqual(isEpicBranch(''), false);
    });

    test('returns false for branch with extra segments', () => {
        assert.strictEqual(isEpicBranch('800-epic-one-two-three-xyz'), false);
    });

});

describe('extractFirstIssueIdFromEpicBranch', () => {

    test('extracts issue ID from valid epic branch', () => {
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('800-epic-short-name-x7y'), 800);
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('1-epic-test-branch-abc'), 1);
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('99999-epic-long-name-z9z'), 99999);
    });

    test('returns null for non-epic branches', () => {
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('main'), null);
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('feature/123-some-feature'), null);
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('develop'), null);
    });

    test('returns null for malformed epic branches', () => {
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('epic-no-id-xyz'), null);
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('abc-epic-word-word-xyz'), null);
    });

    test('returns null for empty string', () => {
        assert.strictEqual(extractFirstIssueIdFromEpicBranch(''), null);
    });

    test('extracts correct ID regardless of words', () => {
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('42-epic-foo-bar-abc'), 42);
        assert.strictEqual(extractFirstIssueIdFromEpicBranch('1000-epic-a1-b2-xyz'), 1000);
    });

});

describe('EPIC_BRANCH_PATTERN', () => {

    test('pattern matches valid epic branch names', () => {
        const validBranches = [
            '1-epic-a-b-abc',
            '100-epic-test-plan-xyz',
            '800-epic-short-name-x7y',
            '99999-epic-feature-update-9z9',
            '1-epic-v2-release-000',
            '123-epic-abc-def-123',
            '1-epic-a1-b2-c3d',
        ];

        for (const branch of validBranches) {
            assert.ok(EPIC_BRANCH_PATTERN.test(branch),
                `Pattern should match: ${branch}`);
        }
    });

    test('pattern does not match invalid branch names', () => {
        const invalidBranches = [
            'main',
            'feature/something',
            '100-feature-test-xyz', // missing epic
            'epic-test-plan-xyz', // missing issue ID
            '100-epic-test-xyz', // only one word before suffix
            '100-epic-test-plan-xy', // suffix too short
            '100-epic-test-plan-xyza', // suffix too long
            '100-EPIC-test-plan-xyz', // uppercase EPIC
            '100-epic-Test-plan-xyz', // uppercase in words
            '100-epic-test-plan-XYZ', // uppercase suffix
            '', // empty
            '100-epic--name-xyz', // empty word
            '-100-epic-test-name-xyz', // starts with hyphen
        ];

        for (const branch of invalidBranches) {
            assert.ok(!EPIC_BRANCH_PATTERN.test(branch),
                `Pattern should NOT match: ${branch}`);
        }
    });

    test('pattern captures groups correctly', () => {
        const match = '800-epic-short-name-x7y'.match(EPIC_BRANCH_PATTERN);

        assert.ok(match, 'Should match the pattern');
        assert.strictEqual(match![1], '800', 'First capture group should be issue ID');
        assert.strictEqual(match![2], 'short', 'Second capture group should be word 1');
        assert.strictEqual(match![3], 'name', 'Third capture group should be word 2');
        assert.strictEqual(match![4], 'x7y', 'Fourth capture group should be random suffix');
    });

    test('pattern captures numeric words correctly', () => {
        const match = '123-epic-v2-release1-abc'.match(EPIC_BRANCH_PATTERN);

        assert.ok(match, 'Should match with numeric words');
        assert.strictEqual(match![1], '123');
        assert.strictEqual(match![2], 'v2');
        assert.strictEqual(match![3], 'release1');
        assert.strictEqual(match![4], 'abc');
    });

});

describe('integration: generateEpicBranchName and validation', () => {

    test('generated branch names with valid plan names pass isEpicBranch validation', () => {
        // These test cases all have valid plan names that produce two words
        const testCases = [
            { id: 1, name: 'Simple Plan' },
            { id: 999, name: 'Feature Update' },
            { id: 12345, name: 'UPPERCASE NAME' },
            { id: 42, name: 'with special!@#$ chars' },
            { id: 200, name: 'single' },  // single word gets '-branch' suffix
            { id: 300, name: 'three word plan' },
            { id: 400, name: 'Numbers123 Here456' },
        ];

        for (const tc of testCases) {
            const branchName = generateEpicBranchName(tc.id, tc.name);
            assert.ok(isEpicBranch(branchName),
                `Generated branch "${branchName}" from (${tc.id}, "${tc.name}") should pass isEpicBranch`);
        }
    });

    test('empty plan name generates fallback branch format', () => {
        // Empty plan name returns "epic" as single word, creating format: {id}-epic-epic-{suffix}
        // This is a valid fallback but doesn't match the standard 4-segment pattern
        const branchName = generateEpicBranchName(100, '');

        // Should have the structure {id}-epic-epic-{suffix}
        assert.match(branchName, /^100-epic-epic-[a-z0-9]{3}$/,
            `Empty plan name should create fallback format: ${branchName}`);

        // Note: This format has only one word after "epic-" prefix, so it doesn't match
        // the standard EPIC_BRANCH_PATTERN which expects two words
    });

    test('special-chars-only plan name generates fallback branch format', () => {
        // Plan name with only special chars also returns "epic" fallback
        const branchName = generateEpicBranchName(500, '!@#$%');

        assert.match(branchName, /^500-epic-epic-[a-z0-9]{3}$/,
            `Special-chars plan name should create fallback format: ${branchName}`);
    });

    test('all generated branch names have extractable issue IDs', () => {
        const testCases = [
            { id: 1, name: 'Plan A' },
            { id: 999, name: 'Plan B' },
            { id: 12345, name: 'Plan C' },
        ];

        for (const tc of testCases) {
            const branchName = generateEpicBranchName(tc.id, tc.name);
            const extractedId = extractFirstIssueIdFromEpicBranch(branchName);
            assert.strictEqual(extractedId, tc.id,
                `Should extract ID ${tc.id} from "${branchName}"`);
        }
    });

    test('generated branch names with valid plans match EPIC_BRANCH_PATTERN', () => {
        // These test cases produce valid two-word truncated names
        const testCases = [
            { id: 1, name: 'A B C D E F' },
            { id: 2000, name: 'word' },  // single word gets '-branch' suffix
            { id: 3000, name: 'Test Plan' },
        ];

        for (const tc of testCases) {
            const branchName = generateEpicBranchName(tc.id, tc.name);
            assert.ok(EPIC_BRANCH_PATTERN.test(branchName),
                `Branch "${branchName}" should match EPIC_BRANCH_PATTERN`);
        }
    });

});
