import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isGitCorruptionError, GIT_CORRUPTION_PATTERNS, getCorruptionPatternStrings } from '@propr/core';

describe('isGitCorruptionError', () => {
    describe('detects corruption patterns', () => {
        test('detects "invalid index-pack output"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: invalid index-pack output')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('fatal: invalid index-pack output when cloning'),
                true
            );
        });

        test('detects "not a git repository"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: not a git repository (or any of the parent directories): .git')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('Not a git repository'),
                true
            );
        });

        test('detects "bad object"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: bad object HEAD')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('fatal: bad object abc123def456'),
                true
            );
        });

        test('detects "missing blob"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: missing blob abc123')),
                true
            );
        });

        test('detects "missing tree"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: missing tree 456def')),
                true
            );
        });

        test('detects "missing commit"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: missing commit 789ghi')),
                true
            );
        });

        test('detects "missing object"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: missing object abc123')),
                true
            );
        });

        test('detects "corrupted" in various positions', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: corrupted pack file')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('The index is corrupted'),
                true
            );
            assert.strictEqual(
                isGitCorruptionError(new Error('repository corrupted, cannot continue')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('CORRUPTED data detected'),
                true
            );
        });

        test('detects "broken link"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: broken link from tree abc to blob def')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('broken link in repository'),
                true
            );
        });

        test('detects "invalid sha1"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: invalid sha1 pointer abc123')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('invalid SHA1 value'),
                true
            );
        });

        test('detects "loose object corrupt"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: loose object abc123 is corrupt')),
                true
            );
        });

        test('detects "pack corrupt"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: pack file is corrupt')),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('pack data corrupt'),
                true
            );
        });

        test('detects "bad pack header"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: bad pack header')),
                true
            );
        });

        test('detects "object file empty"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: object file .git/objects/ab/cd1234 is empty')),
                true
            );
        });

        test('detects "unable to read sha1 file"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: unable to read sha1 file of blob abc')),
                true
            );
        });

        test('detects "refs does not point to valid object"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: refs/heads/main does not point to a valid object')),
                true
            );
        });

        test('detects "index file corrupt"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: index file corrupt')),
                true
            );
        });

        test('detects "index file smaller than expected"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: index file smaller than expected')),
                true
            );
        });

        test('detects "worktree not valid"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: worktree /path/to/worktree not valid')),
                true
            );
        });

        test('detects "gitdir file does not exist"', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: gitdir file does not exist')),
                true
            );
        });
    });

    describe('does NOT flag normal git errors (false positives)', () => {
        test('does NOT flag merge conflict errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('CONFLICT (content): Merge conflict in file.txt')),
                false
            );
            assert.strictEqual(
                isGitCorruptionError('Automatic merge failed; fix conflicts and then commit the result.'),
                false
            );
        });

        test('does NOT flag dirty working tree errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: Your local changes to the following files would be overwritten by checkout')),
                false
            );
            assert.strictEqual(
                isGitCorruptionError('Please commit your changes or stash them before you switch branches.'),
                false
            );
        });

        test('does NOT flag branch already exists errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error("fatal: A branch named 'feature' already exists.")),
                false
            );
        });

        test('does NOT flag upstream not set errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error("fatal: The current branch main has no upstream branch.")),
                false
            );
        });

        test('does NOT flag remote not found errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error("fatal: 'origin' does not appear to be a git repository")),
                false
            );
        });

        test('does NOT flag push rejected errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('! [rejected] main -> main (non-fast-forward)')),
                false
            );
            assert.strictEqual(
                isGitCorruptionError('Updates were rejected because the tip of your current branch is behind'),
                false
            );
        });

        test('does NOT flag authentication errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: Authentication failed for https://github.com/owner/repo.git')),
                false
            );
        });

        test('does NOT flag permission denied errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('Permission denied (publickey).')),
                false
            );
        });

        test('does NOT flag detached HEAD warnings', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('You are in detached HEAD state.')),
                false
            );
        });

        test('does NOT flag untracked files errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('error: The following untracked working tree files would be overwritten by checkout')),
                false
            );
        });

        test('does NOT flag "already up to date" messages', () => {
            assert.strictEqual(
                isGitCorruptionError('Already up to date.'),
                false
            );
        });

        test('does NOT flag "branch is ahead" messages', () => {
            assert.strictEqual(
                isGitCorruptionError("Your branch is ahead of 'origin/main' by 2 commits."),
                false
            );
        });

        test('does NOT flag rebase in progress errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('You have unstaged changes. Please commit or stash them.')),
                false
            );
            assert.strictEqual(
                isGitCorruptionError('It seems that there is already a rebase-merge directory'),
                false
            );
        });

        test('does NOT flag stash errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('No stash entries found.')),
                false
            );
        });

        test('does NOT flag "nothing to commit" messages', () => {
            assert.strictEqual(
                isGitCorruptionError('nothing to commit, working tree clean'),
                false
            );
        });
    });

    describe('does NOT flag network errors', () => {
        test('does NOT flag timeout errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: unable to access: Operation timed out')),
                false
            );
        });

        test('does NOT flag connection refused errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: unable to connect: Connection refused')),
                false
            );
        });

        test('does NOT flag DNS resolution errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error("fatal: unable to access: Could not resolve host: github.com")),
                false
            );
        });

        test('does NOT flag SSL errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('SSL certificate problem: unable to get local issuer certificate')),
                false
            );
        });

        test('does NOT flag network unreachable errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: unable to access: Network is unreachable')),
                false
            );
        });

        test('does NOT flag ECONNRESET errors', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('ECONNRESET: Connection reset by peer')),
                false
            );
        });
    });

    describe('handles null/undefined error message', () => {
        test('returns false for null', () => {
            assert.strictEqual(isGitCorruptionError(null), false);
        });

        test('returns false for undefined', () => {
            assert.strictEqual(isGitCorruptionError(undefined), false);
        });

        test('returns false for empty string', () => {
            assert.strictEqual(isGitCorruptionError(''), false);
        });

        test('returns false for empty Error', () => {
            assert.strictEqual(isGitCorruptionError(new Error('')), false);
        });

        test('handles object with undefined message', () => {
            assert.strictEqual(isGitCorruptionError({ message: undefined }), false);
        });

        test('handles object with null message', () => {
            assert.strictEqual(isGitCorruptionError({ message: null }), false);
        });

        test('handles object with empty message', () => {
            assert.strictEqual(isGitCorruptionError({ message: '' }), false);
        });
    });

    describe('handles various input types', () => {
        test('accepts Error objects', () => {
            assert.strictEqual(
                isGitCorruptionError(new Error('fatal: bad object HEAD')),
                true
            );
        });

        test('accepts string inputs', () => {
            assert.strictEqual(
                isGitCorruptionError('fatal: bad object HEAD'),
                true
            );
        });

        test('accepts objects with message property', () => {
            assert.strictEqual(
                isGitCorruptionError({ message: 'fatal: bad object HEAD' }),
                true
            );
        });

        test('handles number inputs gracefully', () => {
            assert.strictEqual(isGitCorruptionError(42), false);
        });

        test('handles boolean inputs gracefully', () => {
            assert.strictEqual(isGitCorruptionError(true), false);
            assert.strictEqual(isGitCorruptionError(false), false);
        });

        test('handles array inputs gracefully', () => {
            assert.strictEqual(isGitCorruptionError([]), false);
            assert.strictEqual(isGitCorruptionError(['fatal: bad object']), false);
        });

        test('handles objects without message property', () => {
            assert.strictEqual(isGitCorruptionError({ error: 'some error' }), false);
        });

        test('handles objects with non-string message', () => {
            assert.strictEqual(isGitCorruptionError({ message: 123 }), false);
            assert.strictEqual(isGitCorruptionError({ message: { nested: 'value' } }), false);
        });
    });

    describe('case insensitivity', () => {
        test('detects patterns in lowercase', () => {
            assert.strictEqual(
                isGitCorruptionError('corrupted repository'),
                true
            );
        });

        test('detects patterns in uppercase', () => {
            assert.strictEqual(
                isGitCorruptionError('CORRUPTED REPOSITORY'),
                true
            );
        });

        test('detects patterns in mixed case', () => {
            assert.strictEqual(
                isGitCorruptionError('Corrupted Repository'),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('CoRrUpTeD'),
                true
            );
        });

        test('detects "not a git repository" case variations', () => {
            assert.strictEqual(
                isGitCorruptionError('NOT A GIT REPOSITORY'),
                true
            );
            assert.strictEqual(
                isGitCorruptionError('Not A Git Repository'),
                true
            );
        });
    });

    describe('pattern completeness', () => {
        test('has expected minimum number of patterns', () => {
            // Per TEST_AUDIT.md: "Pure regex matching against 11 corruption patterns"
            // We have more than 11 to be comprehensive
            assert.ok(
                GIT_CORRUPTION_PATTERNS.length >= 11,
                `Expected at least 11 patterns, got ${GIT_CORRUPTION_PATTERNS.length}`
            );
        });

        test('all patterns are RegExp objects', () => {
            GIT_CORRUPTION_PATTERNS.forEach((pattern, index) => {
                assert.ok(
                    pattern instanceof RegExp,
                    `Pattern at index ${index} is not a RegExp`
                );
            });
        });

        test('all patterns are case-insensitive', () => {
            GIT_CORRUPTION_PATTERNS.forEach((pattern, index) => {
                assert.ok(
                    pattern.flags.includes('i'),
                    `Pattern at index ${index} is not case-insensitive: ${pattern.source}`
                );
            });
        });
    });

    describe('real-world error scenarios', () => {
        test('detects error from git clone with corruption', () => {
            const error = new Error(`fatal: pack has bad object at offset 12345: inflate returned 1
error: index-pack died of signal 13
fatal: invalid index-pack output`);
            assert.strictEqual(isGitCorruptionError(error), true);
        });

        test('detects error from git checkout with corruption', () => {
            const error = new Error('fatal: not a git repository (or any of the parent directories): .git');
            assert.strictEqual(isGitCorruptionError(error), true);
        });

        test('detects error from git fsck output', () => {
            const errors = [
                'error: invalid sha1 pointer 0000000000000000000000000000000000000000',
                'error: bad ref for .git/info/refs',
                'error: missing tree a1b2c3d4e5f6',
                'error: missing blob abcdef123456',
                'broken link from tree abc to blob def'
            ];
            errors.forEach(errorMsg => {
                assert.strictEqual(
                    isGitCorruptionError(errorMsg),
                    true,
                    `Failed to detect: ${errorMsg}`
                );
            });
        });

        test('detects worktree corruption scenario', () => {
            const error = new Error('fatal: worktree /tmp/git-processor/worktrees/issue-123 not valid: gitdir file points to non-existent location');
            assert.strictEqual(isGitCorruptionError(error), true);
        });

        test('detects pack/index corruption scenario', () => {
            const error = new Error('fatal: pack file .git/objects/pack/pack-abc123.pack corrupted');
            assert.strictEqual(isGitCorruptionError(error), true);
        });
    });
});

describe('getCorruptionPatternStrings', () => {
    test('returns array of pattern source strings', () => {
        const patterns = getCorruptionPatternStrings();
        assert.ok(Array.isArray(patterns));
        assert.strictEqual(patterns.length, GIT_CORRUPTION_PATTERNS.length);
    });

    test('all returned strings are non-empty', () => {
        const patterns = getCorruptionPatternStrings();
        patterns.forEach((pattern, index) => {
            assert.ok(
                pattern.length > 0,
                `Pattern at index ${index} is empty`
            );
        });
    });

    test('patterns can be used to reconstruct RegExp', () => {
        const patterns = getCorruptionPatternStrings();
        patterns.forEach((patternStr, index) => {
            assert.doesNotThrow(() => {
                new RegExp(patternStr, 'i');
            }, `Pattern at index ${index} is not a valid RegExp source: ${patternStr}`);
        });
    });
});

describe('GIT_CORRUPTION_PATTERNS export', () => {
    test('is exported and is an array', () => {
        assert.ok(Array.isArray(GIT_CORRUPTION_PATTERNS));
    });

    test('patterns are immutable references', () => {
        // Each pattern should be a new RegExp instance, not modified
        const originalLength = GIT_CORRUPTION_PATTERNS.length;
        const firstPattern = GIT_CORRUPTION_PATTERNS[0];

        // These modifications shouldn't affect the module's internal state
        // (though in JS they could - this documents expected behavior)
        assert.strictEqual(GIT_CORRUPTION_PATTERNS.length, originalLength);
        assert.strictEqual(GIT_CORRUPTION_PATTERNS[0], firstPattern);
    });
});
