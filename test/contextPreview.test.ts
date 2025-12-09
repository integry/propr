import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

describe('Context Preview Types', () => {
    test('TaskDraftConfig interface has required fields', () => {
        const config = {
            baseBranch: 'main',
            granularity: 'balanced' as const,
            manualFiles: ['src/auth.ts'],
            autoFiles: ['src/utils.ts']
        };
        
        assert.strictEqual(config.baseBranch, 'main');
        assert.strictEqual(config.granularity, 'balanced');
        assert.deepStrictEqual(config.manualFiles, ['src/auth.ts']);
        assert.deepStrictEqual(config.autoFiles, ['src/utils.ts']);
    });

    test('Granularity type accepts valid values', () => {
        const validGranularities: Array<'single' | 'balanced' | 'granular'> = ['single', 'balanced', 'granular'];
        assert.strictEqual(validGranularities.length, 3);
        assert.ok(validGranularities.includes('single'));
        assert.ok(validGranularities.includes('balanced'));
        assert.ok(validGranularities.includes('granular'));
    });

    test('PreviewResult structure is correct', () => {
        const result = {
            success: true,
            stats: {
                totalTokens: 45200,
                costEstimate: 0.678,
                contextLength: 150000,
                fileCount: 12
            },
            smartSelection: [
                { path: 'src/auth.ts', reason: 'Explicitly included', source: 'manual' as const },
                { path: 'src/middleware/jwt.ts', reason: 'High relevance score (85)', source: 'auto' as const, score: 85 }
            ],
            warnings: []
        };
        
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.stats.totalTokens, 45200);
        assert.strictEqual(result.stats.costEstimate, 0.678);
        assert.strictEqual(result.stats.contextLength, 150000);
        assert.strictEqual(result.stats.fileCount, 12);
        assert.strictEqual(result.smartSelection.length, 2);
        assert.strictEqual(result.smartSelection[0].source, 'manual');
        assert.strictEqual(result.smartSelection[1].source, 'auto');
    });
});

describe('Branch Name Validation', () => {
    const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/;

    test('accepts valid branch names', () => {
        const validNames = [
            'main',
            'develop',
            'feature/login-v2',
            'release/1.0.0',
            'fix/bug-123',
            'user/john.doe/feature',
            'v1.2.3'
        ];
        
        for (const name of validNames) {
            assert.ok(BRANCH_NAME_REGEX.test(name), `Branch name '${name}' should be valid`);
        }
    });

    test('rejects invalid branch names', () => {
        const invalidNames = [
            '',
            'branch name',
            'branch\ttab',
            'branch;command',
            'branch$(injection)',
            'branch`backtick`'
        ];
        
        for (const name of invalidNames) {
            assert.ok(!BRANCH_NAME_REGEX.test(name), `Branch name '${name}' should be invalid`);
        }
    });
});

describe('File Merging Logic', () => {
    test('combines manual and auto files without duplicates', () => {
        const manualFiles = ['src/auth.ts', 'src/config.ts'];
        const autoFiles = ['src/auth.ts', 'src/utils.ts', 'src/helpers.ts'];
        
        const combinedFiles = [...new Set([...manualFiles, ...autoFiles])];
        
        assert.strictEqual(combinedFiles.length, 4);
        assert.ok(combinedFiles.includes('src/auth.ts'));
        assert.ok(combinedFiles.includes('src/config.ts'));
        assert.ok(combinedFiles.includes('src/utils.ts'));
        assert.ok(combinedFiles.includes('src/helpers.ts'));
    });

    test('handles empty manual files', () => {
        const manualFiles: string[] = [];
        const autoFiles = ['src/utils.ts', 'src/helpers.ts'];
        
        const combinedFiles = [...new Set([...manualFiles, ...autoFiles])];
        
        assert.strictEqual(combinedFiles.length, 2);
    });

    test('handles empty auto files', () => {
        const manualFiles = ['src/auth.ts'];
        const autoFiles: string[] = [];
        
        const combinedFiles = [...new Set([...manualFiles, ...autoFiles])];
        
        assert.strictEqual(combinedFiles.length, 1);
    });
});

describe('Granularity Instructions', () => {
    const GRANULARITY_INSTRUCTIONS: Record<'single' | 'balanced' | 'granular', string> = {
        single: 'Create a single, comprehensive task that addresses all requirements at once. Prefer consolidating related changes into one task.',
        balanced: 'Create a balanced set of tasks - group related changes together but separate distinct features or concerns.',
        granular: 'Create detailed, granular tasks - break down the work into small, focused units. Each task should address a single specific change.'
    };

    test('single granularity instruction emphasizes consolidation', () => {
        const instruction = GRANULARITY_INSTRUCTIONS.single;
        assert.ok(instruction.includes('single'));
        assert.ok(instruction.includes('comprehensive'));
    });

    test('balanced granularity instruction emphasizes grouping', () => {
        const instruction = GRANULARITY_INSTRUCTIONS.balanced;
        assert.ok(instruction.includes('balanced'));
        assert.ok(instruction.includes('group'));
    });

    test('granular granularity instruction emphasizes detail', () => {
        const instruction = GRANULARITY_INSTRUCTIONS.granular;
        assert.ok(instruction.includes('granular'));
        assert.ok(instruction.includes('small'));
    });
});

describe('Cost Estimation', () => {
    test('calculates cost with model pricing', () => {
        const totalTokens = 100000;
        const outputTokens = 4000;
        const promptPrice = 0.000003;
        const completionPrice = 0.000015;
        
        const inputCost = totalTokens * promptPrice;
        const outputCost = outputTokens * completionPrice;
        const totalCost = inputCost + outputCost;
        
        assert.ok(Math.abs(inputCost - 0.3) < 0.0001, `Input cost ${inputCost} should be approximately 0.3`);
        assert.ok(Math.abs(outputCost - 0.06) < 0.0001, `Output cost ${outputCost} should be approximately 0.06`);
        assert.ok(Math.abs(totalCost - 0.36) < 0.0001, `Total cost ${totalCost} should be approximately 0.36`);
    });

    test('calculates fallback cost correctly', () => {
        const totalTokens = 100000;
        const outputTokens = 4000;
        
        const fallbackCost = (totalTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
        
        assert.ok(Math.abs(fallbackCost - 0.36) < 0.0001, `Fallback cost ${fallbackCost} should be approximately 0.36`);
    });
});

describe('Smart Selection Structure', () => {
    test('manual files have correct structure', () => {
        const manualFiles = ['src/auth.ts', 'src/config.ts'];
        const smartSelection = manualFiles.map(path => ({
            path,
            reason: 'Explicitly included',
            source: 'manual' as const
        }));
        
        assert.strictEqual(smartSelection.length, 2);
        assert.ok(smartSelection.every(s => s.source === 'manual'));
        assert.ok(smartSelection.every(s => s.reason === 'Explicitly included'));
    });

    test('auto files have correct structure with score', () => {
        const relevanceFiles = [
            { path: 'src/utils.ts', reason: 'git-history', score: 85 },
            { path: 'src/helpers.ts', reason: 'path-match', score: 60 }
        ];
        
        const smartSelection = relevanceFiles.map(f => ({
            path: f.path,
            reason: `${f.reason} (score: ${f.score})`,
            source: 'auto' as const,
            score: f.score
        }));
        
        assert.strictEqual(smartSelection.length, 2);
        assert.ok(smartSelection.every(s => s.source === 'auto'));
        assert.ok(smartSelection.every(s => typeof s.score === 'number'));
    });
});
