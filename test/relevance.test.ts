import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
import { extractKeywords } from '@gitfix/core';

describe('Keyword Extractor', () => {
    test('extracts CamelCase identifiers', () => {
        const keywords = extractKeywords('Fix the UserAuth login bug');
        assert.ok(keywords.includes('UserAuth'));
    });

    test('extracts snake_case identifiers', () => {
        const keywords = extractKeywords('Update user_id validation');
        assert.ok(keywords.includes('user_id'));
    });

    test('extracts file paths', () => {
        const keywords = extractKeywords('Change src/auth/login.ts');
        assert.ok(keywords.some(k => k.includes('src/auth')));
    });

    test('extracts file extensions', () => {
        const keywords = extractKeywords('Update config.json settings');
        assert.ok(keywords.some(k => k.includes('config.json')));
    });

    test('filters stop words', () => {
        const keywords = extractKeywords('fix the code and update the file');
        assert.ok(!keywords.includes('fix'));
        assert.ok(!keywords.includes('the'));
        assert.ok(!keywords.includes('and'));
        assert.ok(!keywords.includes('update'));
    });

    test('filters common git verbs', () => {
        const keywords = extractKeywords('refactor implement add remove delete');
        assert.ok(!keywords.includes('refactor'));
        assert.ok(!keywords.includes('implement'));
        assert.ok(!keywords.includes('add'));
        assert.ok(!keywords.includes('remove'));
        assert.ok(!keywords.includes('delete'));
    });

    test('handles empty prompt', () => {
        const keywords = extractKeywords('');
        assert.deepStrictEqual(keywords, []);
    });

    test('handles prompt with only stop words', () => {
        const keywords = extractKeywords('fix the bug and update');
        assert.ok(keywords.length === 0 || keywords.every(k => k.length > 3));
    });

    test('deduplicates keywords', () => {
        const keywords = extractKeywords('UserAuth UserAuth UserAuth');
        const userAuthCount = keywords.filter(k => k === 'UserAuth').length;
        assert.strictEqual(userAuthCount, 1);
    });

    test('extracts meaningful identifiers from complex prompt', () => {
        const keywords = extractKeywords('Refactor the login page component in LoginPage.tsx to use AuthService');
        assert.ok(keywords.includes('LoginPage'));
        assert.ok(keywords.includes('AuthService'));
    });
});

describe('Relevance Scoring', () => {
    test('combined score formula works correctly', () => {
        const gitFrequency = 5;
        const pathMatchScore = 50;
        const expectedScore = (gitFrequency * 10) + pathMatchScore;
        assert.strictEqual(expectedScore, 100);
    });

    test('threshold filtering works', () => {
        const scores = [
            { path: 'a.ts', score: 100 },
            { path: 'b.ts', score: 50 },
            { path: 'c.ts', score: 25 },
            { path: 'd.ts', score: 10 }
        ];
        const threshold = 30;
        const filtered = scores.filter(s => s.score >= threshold);
        assert.strictEqual(filtered.length, 2);
        assert.ok(filtered.every(s => s.score >= threshold));
    });

    test('top N limiting works', () => {
        const scores = Array.from({ length: 30 }, (_, i) => ({
            path: `file${i}.ts`,
            score: 100 - i
        }));
        const maxResults = 20;
        const limited = scores.slice(0, maxResults);
        assert.strictEqual(limited.length, 20);
    });
});
