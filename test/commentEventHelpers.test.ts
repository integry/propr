import { test, mock, describe } from 'node:test';
import assert from 'node:assert';

// Mock @propr/shared to avoid package resolution failure
await mock.module('@propr/shared', {
    namedExports: {
        MODEL_ALIASES: {},
    },
});

// Mock modelDefinitions to avoid transitive dependency issues
await mock.module('../packages/core/src/config/modelDefinitions.js', {
    namedExports: {
        MODEL_INFO_MAP: {},
        modelDefinitions: [],
    },
});

const { modelLabelPrefix, buildCodeContext, isReviewComment, stripKeywordsFromBody } = await import(
    '../packages/core/src/webhook/commentEventHelpers.js'
);

describe('modelLabelPrefix', () => {
    test('derives prefix from default pattern ^llm-(.+)$', () => {
        const result = modelLabelPrefix('^llm-(.+)$');
        assert.deepStrictEqual(result, { prefix: 'llm-', derived: true });
    });

    test('derives prefix from custom pattern ^ai-model-(.+)$', () => {
        const result = modelLabelPrefix('^ai-model-(.+)$');
        assert.deepStrictEqual(result, { prefix: 'ai-model-', derived: true });
    });

    test('derives prefix from pattern without anchors', () => {
        const result = modelLabelPrefix('model-(.+)');
        assert.deepStrictEqual(result, { prefix: 'model-', derived: true });
    });

    test('falls back to llm- for pattern with no capture group', () => {
        const result = modelLabelPrefix('^llm-.+$');
        assert.deepStrictEqual(result, { prefix: 'llm-', derived: false });
    });

    test('falls back to llm- for pattern with capture group at start', () => {
        const result = modelLabelPrefix('^(.+)-llm$');
        assert.deepStrictEqual(result, { prefix: 'llm-', derived: false });
    });

    test('derives prefix from pattern with escaped metacharacters like ^llm\\.(.+)$', () => {
        const result = modelLabelPrefix('^llm\\.(.+)$');
        assert.deepStrictEqual(result, { prefix: 'llm.', derived: true });
    });

    test('derives prefix from pattern with escaped hyphen ^model\\-(.+)$', () => {
        const result = modelLabelPrefix('^model\\-(.+)$');
        assert.deepStrictEqual(result, { prefix: 'model-', derived: true });
    });

    test('falls back to llm- for pattern with unescaped metacharacters in prefix', () => {
        const result = modelLabelPrefix('^llm.*(.+)$');
        assert.deepStrictEqual(result, { prefix: 'llm-', derived: false });
    });

    test('falls back to llm- for empty pattern', () => {
        const result = modelLabelPrefix('');
        assert.deepStrictEqual(result, { prefix: 'llm-', derived: false });
    });
});

describe('buildCodeContext', () => {
    test('returns empty array for comment with no context', () => {
        const result = buildCodeContext({});
        assert.deepStrictEqual(result, []);
    });

    test('includes file path when present', () => {
        const result = buildCodeContext({ path: 'src/index.ts' });
        assert.deepStrictEqual(result, ['File: src/index.ts']);
    });

    test('includes file path and line number', () => {
        const result = buildCodeContext({ path: 'src/index.ts', line: 42 });
        assert.deepStrictEqual(result, ['File: src/index.ts', 'Line: 42']);
    });

    test('includes diff hunk in code block', () => {
        const result = buildCodeContext({ diff_hunk: '@@ -1,5 +1,10 @@' });
        assert.deepStrictEqual(result, ['Code context:', '```diff', '@@ -1,5 +1,10 @@', '```']);
    });

    test('includes all fields when present', () => {
        const result = buildCodeContext({ path: 'src/app.ts', line: 10, diff_hunk: '@@ -1,3 +1,5 @@' });
        assert.strictEqual(result.length, 6);
        assert.strictEqual(result[0], 'File: src/app.ts');
        assert.strictEqual(result[1], 'Line: 10');
        assert.strictEqual(result[2], 'Code context:');
    });

    test('excludes line when null', () => {
        const result = buildCodeContext({ path: 'src/index.ts', line: null });
        assert.deepStrictEqual(result, ['File: src/index.ts']);
    });
});

describe('isReviewComment', () => {
    test('returns true for pull_request_review_comment event type', () => {
        assert.strictEqual(isReviewComment({}, 'pull_request_review_comment'), true);
    });

    test('returns true when comment has pull_request_review_id', () => {
        assert.strictEqual(isReviewComment({ pull_request_review_id: 123 }, 'issue_comment'), true);
    });

    test('returns false for issue comment without review id', () => {
        assert.strictEqual(isReviewComment({}, 'issue_comment'), false);
    });

    test('returns false when pull_request_review_id is undefined', () => {
        assert.strictEqual(isReviewComment({ pull_request_review_id: undefined }, 'issue_comment'), false);
    });
});

describe('stripKeywordsFromBody', () => {
    test('strips keyword from body', () => {
        const result = stripKeywordsFromBody('propr fix the bug', ['propr']);
        assert.strictEqual(result, 'fix the bug');
    });

    test('strips keyword with model suffix', () => {
        const result = stripKeywordsFromBody('propr:claude fix the bug', ['propr']);
        assert.strictEqual(result, 'fix the bug');
    });

    test('strips multiple keywords', () => {
        const result = stripKeywordsFromBody('propr ai-review fix the bug', ['propr', 'ai-review']);
        assert.strictEqual(result, 'fix the bug');
    });

    test('returns trimmed body when no keywords match', () => {
        const result = stripKeywordsFromBody('  fix the bug  ', ['propr']);
        assert.strictEqual(result, 'fix the bug');
    });

    test('handles empty keywords array', () => {
        const result = stripKeywordsFromBody('fix the bug', []);
        assert.strictEqual(result, 'fix the bug');
    });

    test('handles body with only keyword', () => {
        const result = stripKeywordsFromBody('propr', ['propr']);
        assert.strictEqual(result, '');
    });
});
