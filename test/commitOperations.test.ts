import { test, describe } from 'node:test';
import assert from 'node:assert';

interface CommitMessageObject {
    claudeSuggested?: string;
}

/**
 * Re-implementation of resolveCommitMessage for testing purposes.
 * This mirrors the function in packages/core/src/git/commitOperations.ts
 */
function resolveCommitMessage(commitMessage: string | CommitMessageObject, issueNumber?: number, issueTitle?: string): string {
    if (typeof commitMessage === 'object' && commitMessage.claudeSuggested) {
        return commitMessage.claudeSuggested;
    }
    if (typeof commitMessage === 'string') {
        return commitMessage;
    }
    const shortTitle = issueTitle ? issueTitle.substring(0, 50).replace(/\s+/g, ' ').trim() : 'issue fix';
    return `fix(ai): Resolve issue #${issueNumber} - ${shortTitle}\n\nImplemented by Claude Code. Full conversation log in PR comment.`;
}

describe('resolveCommitMessage', () => {
    describe('when given a CommitMessageObject with claudeSuggested', () => {
        test('uses claudeSuggested from object input', () => {
            const commitMessage = { claudeSuggested: 'feat: add new feature' };
            const result = resolveCommitMessage(commitMessage, 123, 'Some issue title');
            assert.strictEqual(result, 'feat: add new feature');
        });

        test('uses claudeSuggested even when issueNumber and issueTitle are provided', () => {
            const commitMessage = { claudeSuggested: 'fix: resolve bug in authentication' };
            const result = resolveCommitMessage(commitMessage, 456, 'Authentication bug');
            assert.strictEqual(result, 'fix: resolve bug in authentication');
        });

        test('handles multi-line claudeSuggested messages', () => {
            const commitMessage = { claudeSuggested: 'feat: add login\n\nThis adds a new login feature with OAuth support.' };
            const result = resolveCommitMessage(commitMessage);
            assert.strictEqual(result, 'feat: add login\n\nThis adds a new login feature with OAuth support.');
        });
    });

    describe('when given a string input', () => {
        test('uses string input as-is', () => {
            const result = resolveCommitMessage('fix: correct typo in README');
            assert.strictEqual(result, 'fix: correct typo in README');
        });

        test('preserves the exact string without modification', () => {
            const customMessage = 'Custom commit message with special chars: !@#$%^&*()';
            const result = resolveCommitMessage(customMessage, 789, 'Issue title');
            assert.strictEqual(result, 'Custom commit message with special chars: !@#$%^&*()');
        });

        test('handles empty string input', () => {
            const result = resolveCommitMessage('');
            assert.strictEqual(result, '');
        });

        test('handles multi-line string input', () => {
            const message = 'feat: add feature\n\nDetailed description here.';
            const result = resolveCommitMessage(message);
            assert.strictEqual(result, 'feat: add feature\n\nDetailed description here.');
        });
    });

    describe('when using fallback message generation', () => {
        test('generates fallback message from issue info', () => {
            const commitMessage: CommitMessageObject = {};
            const result = resolveCommitMessage(commitMessage, 123, 'Fix login bug');
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #123 - Fix login bug\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('truncates title to 50 chars', () => {
            const commitMessage: CommitMessageObject = {};
            const longTitle = 'This is a very long issue title that exceeds the fifty character limit and should be truncated';
            const result = resolveCommitMessage(commitMessage, 456, longTitle);

            // The title part should be truncated to 50 chars (substring(0, 50))
            const expectedTruncatedTitle = longTitle.substring(0, 50);
            assert.strictEqual(expectedTruncatedTitle, 'This is a very long issue title that exceeds the f');
            assert.strictEqual(
                result,
                `fix(ai): Resolve issue #456 - ${expectedTruncatedTitle}\n\nImplemented by Claude Code. Full conversation log in PR comment.`
            );
        });

        test('uses "issue fix" when issueTitle is undefined', () => {
            const commitMessage: CommitMessageObject = {};
            const result = resolveCommitMessage(commitMessage, 789);
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #789 - issue fix\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('uses "issue fix" when issueTitle is empty string', () => {
            const commitMessage: CommitMessageObject = {};
            const result = resolveCommitMessage(commitMessage, 101, '');
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #101 - issue fix\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('normalizes whitespace in issueTitle', () => {
            const commitMessage: CommitMessageObject = {};
            const titleWithExtraSpaces = 'Fix   multiple    spaces   in   title';
            const result = resolveCommitMessage(commitMessage, 202, titleWithExtraSpaces);
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #202 - Fix multiple spaces in title\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('trims leading and trailing whitespace from issueTitle', () => {
            const commitMessage: CommitMessageObject = {};
            const titleWithWhitespace = '   Fix bug with padding   ';
            const result = resolveCommitMessage(commitMessage, 303, titleWithWhitespace);
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #303 - Fix bug with padding\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('handles undefined issueNumber in fallback', () => {
            const commitMessage: CommitMessageObject = {};
            const result = resolveCommitMessage(commitMessage, undefined, 'Some title');
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #undefined - Some title\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('handles title that is exactly 50 characters', () => {
            const commitMessage: CommitMessageObject = {};
            // Create a string that is exactly 50 characters
            const exactTitle = '12345678901234567890123456789012345678901234567890';
            assert.strictEqual(exactTitle.length, 50);
            const result = resolveCommitMessage(commitMessage, 404, exactTitle);
            assert.strictEqual(
                result,
                `fix(ai): Resolve issue #404 - ${exactTitle}\n\nImplemented by Claude Code. Full conversation log in PR comment.`
            );
        });

        test('handles title that is 51 characters (just over limit)', () => {
            const commitMessage: CommitMessageObject = {};
            // Create a string that is exactly 51 characters
            const overLimitTitle = '123456789012345678901234567890123456789012345678901';
            assert.strictEqual(overLimitTitle.length, 51);
            const result = resolveCommitMessage(commitMessage, 505, overLimitTitle);
            const expectedTruncated = overLimitTitle.substring(0, 50);
            assert.strictEqual(expectedTruncated.length, 50);
            assert.strictEqual(
                result,
                `fix(ai): Resolve issue #505 - ${expectedTruncated}\n\nImplemented by Claude Code. Full conversation log in PR comment.`
            );
        });
    });

    describe('edge cases', () => {
        test('handles object with empty claudeSuggested string', () => {
            // Empty string is falsy, so it falls through to string check or fallback
            const commitMessage = { claudeSuggested: '' };
            const result = resolveCommitMessage(commitMessage, 606, 'Fallback title');
            // Since empty string is falsy, the check `commitMessage.claudeSuggested` fails
            // and since it's an object (not string), it goes to fallback
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #606 - Fallback title\n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });

        test('handles whitespace-only issueTitle', () => {
            const commitMessage: CommitMessageObject = {};
            const result = resolveCommitMessage(commitMessage, 808, '     ');
            // The truthy check passes since '     ' is not empty, but after processing it becomes empty
            // However, the ternary check `issueTitle ?` passes, so it uses substring(0,50).replace().trim() which is ''
            assert.strictEqual(
                result,
                'fix(ai): Resolve issue #808 - \n\nImplemented by Claude Code. Full conversation log in PR comment.'
            );
        });
    });
});
