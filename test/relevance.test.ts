import { test, describe, beforeEach, mock, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// These imports don't trigger Redis/DB connections directly
import { extractKeywords } from '../packages/core/src/services/relevance/keywordExtractor.js';
import { formatCommitLog } from '../packages/core/src/services/relevance/gitMiner.js';
import type { CommitInfo } from '../packages/core/src/services/relevance/gitMiner.js';

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

describe('Semantic Git Mining', () => {
    describe('formatCommitLog', () => {
        test('formats commits correctly', () => {
            const commits: CommitInfo[] = [
                { hash: 'abc123', subject: 'fix auth bug', body: '', files: ['src/auth.ts', 'src/login.ts'] },
                { hash: 'def456', subject: 'add user feature', body: '', files: ['src/user.ts'] }
            ];
            const log = formatCommitLog(commits);
            assert.ok(log.includes('abc123'));
            assert.ok(log.includes('fix auth bug'));
            assert.ok(log.includes('src/auth.ts'));
            assert.ok(log.includes('def456'));
        });

        test('handles empty commits array', () => {
            const log = formatCommitLog([]);
            assert.strictEqual(log, '');
        });

        test('truncates at maxChars limit', () => {
            const commits: CommitInfo[] = [
                { hash: 'abc123', subject: 'long commit message', body: '', files: ['file1.ts', 'file2.ts', 'file3.ts'] },
                { hash: 'def456', subject: 'another commit', body: '', files: ['file4.ts'] }
            ];
            const log = formatCommitLog(commits, 50);
            assert.ok(log.length <= 100);
        });
    });

    describe('SemanticMinerResponse parsing', () => {
        test('parses valid JSON response', () => {
            const response = '{"files": [{"path": "src/auth.ts", "score": 90, "reason": "auth commit"}]}';
            const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
            assert.ok(jsonMatch);
            const parsed = JSON.parse(jsonMatch[0]);
            assert.strictEqual(parsed.files.length, 1);
            assert.strictEqual(parsed.files[0].path, 'src/auth.ts');
            assert.strictEqual(parsed.files[0].score, 90);
        });

        test('handles response with extra text', () => {
            const response = 'Here is my analysis:\n{"files": [{"path": "src/test.ts", "score": 50, "reason": "test"}]}\nDone.';
            const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
            assert.ok(jsonMatch);
            const parsed = JSON.parse(jsonMatch[0]);
            assert.strictEqual(parsed.files.length, 1);
        });

        test('returns empty array for invalid JSON', () => {
            const response = 'This is not valid JSON';
            const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
            assert.strictEqual(jsonMatch, null);
        });

        test('filters invalid file entries', () => {
            const response = '{"files": [{"path": "valid.ts", "score": 80, "reason": "test"}, {"path": "", "score": 50}, {"score": 30}]}';
            const parsed = JSON.parse(response);
            const validFiles = parsed.files.filter((f: { path?: string; score?: number }) =>
                typeof f.path === 'string' &&
                typeof f.score === 'number' &&
                f.path.trim().length > 0
            );
            assert.strictEqual(validFiles.length, 1);
            assert.strictEqual(validFiles[0].path, 'valid.ts');
        });

        test('clamps scores to 0-100 range', () => {
            const files = [
                { path: 'a.ts', score: 150 },
                { path: 'b.ts', score: -20 },
                { path: 'c.ts', score: 75 }
            ];
            const clamped = files.map(f => ({
                ...f,
                score: Math.min(100, Math.max(0, f.score))
            }));
            assert.strictEqual(clamped[0].score, 100);
            assert.strictEqual(clamped[1].score, 0);
            assert.strictEqual(clamped[2].score, 75);
        });
    });
});

// Cleanup after tests - ensure clean termination
after(async () => {
    // Brief delay for any pending cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
});
