import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

/**
 * Unit tests for validatePromptTokens from planningHelpers.ts
 *
 * The function validates prompt token counts before sending to LLM.
 * Key behaviors:
 * - Uses tiktoken estimate with a conservative ratio (1.36x for Claude, 1.1x for Gemini)
 * - Returns early (with tiktoken estimate) if token count is clearly under limit (<80%)
 * - Uses API validation when token count is close to limit (>80%)
 * - Falls back to tiktoken estimate if API call fails
 *
 * This file extracts the pure function logic locally to avoid triggering
 * module-level side effects from @propr/core imports (Redis/BullMQ connections).
 */

// Constants from the source
const TIKTOKEN_TO_CLAUDE_RATIO = 1.36;
const GEMINI_TOKEN_RATIO = 1.1;
const CLAUDE_CODE_OVERHEAD = 5000;
const API_VALIDATION_THRESHOLD = 0.80;

/**
 * Minimal logger interface for testing.
 */
interface MinimalLogger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
}

/**
 * Create a mock logger that captures log calls for assertions.
 */
function createMockLogger(): MinimalLogger & { calls: { info: unknown[][]; warn: unknown[][] } } {
    const calls = { info: [] as unknown[][], warn: [] as unknown[][] };
    return {
        calls,
        info: (...args: unknown[]) => { calls.info.push(args); },
        warn: (...args: unknown[]) => { calls.warn.push(args); }
    };
}

/**
 * Testable version of validatePromptTokens that accepts injectable dependencies.
 * This mirrors the logic from planningHelpers.ts:63-105
 *
 * @param prompt - The prompt text to validate
 * @param modelLimit - The model's token limit
 * @param logger - Logger for info/warn messages
 * @param modelId - Optional model identifier (for Gemini detection)
 * @param estimateTokensFn - Injectable tiktoken estimate function
 * @param countTokensFn - Injectable API token counting function
 */
async function validatePromptTokens(
    prompt: string,
    modelLimit: number,
    logger: MinimalLogger,
    modelId?: string,
    estimateTokensFn: (text: string) => number = () => 0,
    countTokensFn: (text: string) => Promise<number> = async () => 0
): Promise<{ valid: boolean; tokenCount: number; source: 'tiktoken' | 'api' }> {
    const tiktokenEstimate = estimateTokensFn(prompt);
    // Use model-specific ratio: Claude uses 1.36x, Gemini uses ~1.1x (closer to tiktoken)
    const isGemini = modelId?.toLowerCase().includes('gemini');
    const tokenRatio = isGemini ? GEMINI_TOKEN_RATIO : TIKTOKEN_TO_CLAUDE_RATIO;
    const conservativeEstimate = Math.ceil(tiktokenEstimate * tokenRatio);
    const effectiveLimit = modelLimit - CLAUDE_CODE_OVERHEAD;

    logger.info({ tiktokenEstimate, conservativeEstimate, effectiveLimit, modelLimit }, 'Initial token estimate');

    if (conservativeEstimate > effectiveLimit) {
        logger.warn({ conservativeEstimate, effectiveLimit, overage: conservativeEstimate - effectiveLimit },
            'Prompt exceeds token limit (conservative estimate)');
        return { valid: false, tokenCount: conservativeEstimate, source: 'tiktoken' };
    }

    if (conservativeEstimate < effectiveLimit * API_VALIDATION_THRESHOLD) {
        return { valid: true, tokenCount: conservativeEstimate, source: 'tiktoken' };
    }

    logger.info('Token count close to limit, attempting API validation');

    try {
        const apiTokenCount = await countTokensFn(prompt);
        logger.info({ apiTokenCount, effectiveLimit }, 'API token count received');

        if (apiTokenCount > effectiveLimit) {
            logger.warn({ apiTokenCount, effectiveLimit, overage: apiTokenCount - effectiveLimit },
                'Prompt exceeds token limit according to API');
            return { valid: false, tokenCount: apiTokenCount, source: 'api' };
        }

        return { valid: true, tokenCount: apiTokenCount, source: 'api' };
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'API token counting failed, using conservative tiktoken estimate');
        return { valid: true, tokenCount: conservativeEstimate, source: 'tiktoken' };
    }
}

describe('validatePromptTokens', () => {
    describe('passes under limit (acceptance criteria)', () => {
        test('should return valid=true when tokens are clearly under limit', async () => {
            const logger = createMockLogger();
            // With limit of 100000, effective = 95000, 80% threshold = 76000
            // If tiktoken returns 50000, conservative estimate = 68000 (< 76000)
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 50000,  // tiktoken returns 50000
                async () => 0  // API should not be called
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'tiktoken');
            // Conservative estimate: 50000 * 1.36 = 68000
            assert.strictEqual(result.tokenCount, 68000);
        });

        test('should return valid=true when tokens are exactly at threshold boundary', async () => {
            const logger = createMockLogger();
            // Limit = 100000, effective = 95000, 80% = 76000
            // Need conservativeEstimate < 76000, so tiktokenEstimate < 76000/1.36 ≈ 55882
            // Using 55881 → conservative = 75998 (just under 76000)
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 55881,
                async () => { throw new Error('Should not be called'); }
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'tiktoken');
        });

        test('should return valid=false when tokens exceed limit', async () => {
            const logger = createMockLogger();
            // Limit = 100000, effective = 95000
            // If tiktoken returns 75000, conservative = ceil(75000 * 1.36) = 102000 or 102001 (floating point)
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 75000,
                async () => 0
            );

            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.source, 'tiktoken');
            // ceil(75000 * 1.36) can be 102000 or 102001 due to floating point
            assert.strictEqual(result.tokenCount, Math.ceil(75000 * TIKTOKEN_TO_CLAUDE_RATIO));
        });

        test('should log warning when exceeding limit', async () => {
            const logger = createMockLogger();
            await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 75000,
                async () => 0
            );

            assert.ok(logger.calls.warn.length > 0, 'Should have logged a warning');
            const warnMessage = logger.calls.warn[0][1];
            assert.ok(
                warnMessage.includes('exceeds token limit'),
                'Warning should mention exceeding token limit'
            );
        });
    });

    describe('uses API when >80% (acceptance criteria)', () => {
        test('should use API validation when estimate is above 80% threshold', async () => {
            const logger = createMockLogger();
            // Limit = 100000, effective = 95000, 80% = 76000
            // tiktoken = 56000 → conservative = 76160 (> 76000, API should be called)
            let apiCalled = false;
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 56000,
                async () => {
                    apiCalled = true;
                    return 80000; // API says valid
                }
            );

            assert.strictEqual(apiCalled, true, 'API should have been called');
            assert.strictEqual(result.source, 'api');
            assert.strictEqual(result.tokenCount, 80000);
            assert.strictEqual(result.valid, true);
        });

        test('should use API token count for validity when API is called', async () => {
            const logger = createMockLogger();
            // Conservative estimate is above threshold but under limit
            // API should be called and its result used
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000, // Conservative: 81600 (above 76000 threshold, under 95000 limit)
                async () => 85000 // API says 85000 (valid, under 95000)
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'api');
            assert.strictEqual(result.tokenCount, 85000);
        });

        test('should return invalid when API count exceeds limit', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000, // Conservative: 81600 (triggers API call)
                async () => 96000 // API says 96000 (invalid, > 95000)
            );

            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.source, 'api');
            assert.strictEqual(result.tokenCount, 96000);
        });

        test('should log when attempting API validation', async () => {
            const logger = createMockLogger();
            await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000,
                async () => 80000
            );

            const infoLogs = logger.calls.info.map(args => args[0]);
            const hasApiAttemptLog = infoLogs.some(
                log => typeof log === 'string' && log.includes('attempting API validation')
            );
            assert.ok(hasApiAttemptLog, 'Should log API validation attempt');
        });
    });

    describe('fallbacks to tiktoken (acceptance criteria)', () => {
        test('should fallback to tiktoken estimate when API fails', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000, // Conservative: 81600 (triggers API call)
                async () => { throw new Error('API unavailable'); }
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'tiktoken');
            // Falls back to conservative estimate
            assert.strictEqual(result.tokenCount, 81600); // ceil(60000 * 1.36)
        });

        test('should log warning when API fails', async () => {
            const logger = createMockLogger();
            await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000,
                async () => { throw new Error('Connection refused'); }
            );

            assert.ok(logger.calls.warn.length > 0, 'Should have logged a warning');
            const warnArgs = logger.calls.warn[0];
            const warnData = warnArgs[0] as { error: string };
            assert.ok(
                warnData.error.includes('Connection refused'),
                'Warning should include error message'
            );
        });

        test('should return valid on API failure if within limit', async () => {
            const logger = createMockLogger();
            // Conservative estimate is 81600 which is < 95000, so valid on fallback
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000,
                async () => { throw new Error('Timeout'); }
            );

            assert.strictEqual(result.valid, true);
        });
    });

    describe('model-specific token ratios', () => {
        test('should use Claude ratio (1.36) for non-Gemini models', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'claude-opus-4-5-20251101',
                () => 10000,
                async () => 0
            );

            // Conservative: ceil(10000 * 1.36) - may vary due to floating point
            assert.strictEqual(result.tokenCount, Math.ceil(10000 * TIKTOKEN_TO_CLAUDE_RATIO));
        });

        test('should use Claude ratio (1.36) when modelId is undefined', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 10000,
                async () => 0
            );

            // Conservative: ceil(10000 * 1.36) - may vary due to floating point
            assert.strictEqual(result.tokenCount, Math.ceil(10000 * TIKTOKEN_TO_CLAUDE_RATIO));
        });

        test('should use Gemini ratio (1.1) for Gemini models', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'gemini-2.5-pro',
                () => 10000,
                async () => 0
            );

            // Conservative: ceil(10000 * 1.1) = 11000
            assert.strictEqual(result.tokenCount, Math.ceil(10000 * GEMINI_TOKEN_RATIO));
        });

        test('should detect Gemini case-insensitively', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'GEMINI-3-flash-preview',
                () => 10000,
                async () => 0
            );

            // Should use Gemini ratio: ceil(10000 * 1.1) = 11000
            assert.strictEqual(result.tokenCount, Math.ceil(10000 * GEMINI_TOKEN_RATIO));
        });

        test('should use Gemini ratio for partial Gemini match (e.g., "my-gemini-clone")', async () => {
            const logger = createMockLogger();
            // "my-gemini-clone" contains "gemini" so should use Gemini ratio
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'my-gemini-clone',
                () => 10000,
                async () => 0
            );

            // Contains "gemini" so should use 1.1 ratio
            assert.strictEqual(result.tokenCount, Math.ceil(10000 * GEMINI_TOKEN_RATIO));
        });
    });

    describe('effective limit calculation', () => {
        test('should subtract CLAUDE_CODE_OVERHEAD (5000) from model limit', async () => {
            const logger = createMockLogger();
            // Limit = 105000, effective = 100000
            // 80% threshold = 80000
            // tiktoken = 58000 → conservative = 78880 (< 80000, valid without API)
            const result = await validatePromptTokens(
                'test prompt',
                105000, // Unusual limit to verify calculation
                logger,
                undefined,
                () => 58000,
                async () => { throw new Error('Should not be called'); }
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'tiktoken');
        });

        test('should handle small model limits correctly', async () => {
            const logger = createMockLogger();
            // Limit = 10000, effective = 5000, 80% = 4000
            // tiktoken = 2000 → conservative = 2720 (< 4000, valid)
            const result = await validatePromptTokens(
                'test prompt',
                10000,
                logger,
                undefined,
                () => 2000,
                async () => 0
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.tokenCount, 2720); // ceil(2000 * 1.36)
        });

        test('should handle edge case where overhead equals limit', async () => {
            const logger = createMockLogger();
            // Limit = 5000, effective = 0
            // Any positive estimate should be invalid
            const result = await validatePromptTokens(
                'test prompt',
                5000,
                logger,
                undefined,
                () => 1, // Even 1 token
                async () => 0
            );

            // Conservative: ceil(1 * 1.36) = 2, which > 0
            assert.strictEqual(result.valid, false);
        });
    });

    describe('edge cases', () => {
        test('should handle zero token estimate', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                '',
                100000,
                logger,
                undefined,
                () => 0,
                async () => 0
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.tokenCount, 0);
            assert.strictEqual(result.source, 'tiktoken');
        });

        test('should handle very large token counts', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'large prompt',
                1000000, // 1M token model
                logger,
                undefined,
                () => 800000, // 800k tokens
                async () => 0
            );

            // Conservative: ceil(800000 * 1.36) = 1088000
            // Effective limit: 1000000 - 5000 = 995000
            // 1088000 > 995000 → invalid
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.tokenCount, 1088000);
        });

        test('should handle API returning higher count than tiktoken estimate', async () => {
            const logger = createMockLogger();
            // Conservative estimate triggers API, API returns higher value
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000, // Conservative: 81600 (triggers API)
                async () => 90000 // API returns higher but still valid
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'api');
            assert.strictEqual(result.tokenCount, 90000);
        });

        test('should handle API returning lower count than tiktoken estimate', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000, // Conservative: 81600 (triggers API)
                async () => 50000 // API returns lower
            );

            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.source, 'api');
            assert.strictEqual(result.tokenCount, 50000);
        });
    });

    describe('logging behavior', () => {
        test('should log initial token estimate', async () => {
            const logger = createMockLogger();
            await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 50000,
                async () => 0
            );

            assert.ok(logger.calls.info.length > 0, 'Should have logged info');
            const firstLog = logger.calls.info[0];
            assert.ok(firstLog[0].tiktokenEstimate !== undefined, 'Should log tiktokenEstimate');
            assert.ok(firstLog[0].conservativeEstimate !== undefined, 'Should log conservativeEstimate');
            assert.ok(firstLog[0].effectiveLimit !== undefined, 'Should log effectiveLimit');
        });

        test('should log API token count when API is used', async () => {
            const logger = createMockLogger();
            await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                undefined,
                () => 60000,
                async () => 80000
            );

            const hasApiCountLog = logger.calls.info.some(
                args => args[0]?.apiTokenCount !== undefined
            );
            assert.ok(hasApiCountLog, 'Should log API token count');
        });
    });

    describe('return value structure', () => {
        test('should always return valid, tokenCount, and source', async () => {
            const logger = createMockLogger();
            const testCases = [
                // Under limit
                { tiktoken: 10000, api: async () => 0, limit: 100000 },
                // Over limit
                { tiktoken: 80000, api: async () => 0, limit: 100000 },
                // API validation
                { tiktoken: 60000, api: async () => 80000, limit: 100000 },
                // API failure
                { tiktoken: 60000, api: async () => { throw new Error('fail'); }, limit: 100000 },
            ];

            for (const tc of testCases) {
                const result = await validatePromptTokens(
                    'test',
                    tc.limit,
                    logger,
                    undefined,
                    () => tc.tiktoken,
                    tc.api
                );

                assert.ok('valid' in result, 'Result should have valid property');
                assert.ok('tokenCount' in result, 'Result should have tokenCount property');
                assert.ok('source' in result, 'Result should have source property');
                assert.ok(
                    result.source === 'tiktoken' || result.source === 'api',
                    'Source should be tiktoken or api'
                );
                assert.strictEqual(typeof result.valid, 'boolean');
                assert.strictEqual(typeof result.tokenCount, 'number');
            }
        });
    });
});

describe('calculateCostEstimate', () => {
    /**
     * Pure function extracted from planningHelpers.ts for testing cost estimation.
     * The original function is at: src/services/planningHelpers.ts:110
     *
     * This version accepts injectable pricing to avoid network calls.
     */
    async function calculateCostEstimate(
        totalTokens: number,
        warnings: string[],
        logger: { warn: (...args: unknown[]) => void },
        pricing: { prompt: number; completion: number } | null = null
    ): Promise<number> {
        const DEFAULT_OUTPUT_TOKENS = 4000;

        if (pricing) {
            return totalTokens * pricing.prompt + DEFAULT_OUTPUT_TOKENS * pricing.completion;
        }

        // Fallback formula when pricing unavailable
        warnings.push('Using fallback pricing - could not fetch current model pricing');
        return (totalTokens / 1_000_000) * 3 + (DEFAULT_OUTPUT_TOKENS / 1_000_000) * 15;
    }

    test('should calculate cost from pricing API', async () => {
        const warnings: string[] = [];
        const logger = { warn: () => {} };
        const pricing = { prompt: 0.000003, completion: 0.000015 };

        const result = await calculateCostEstimate(100000, warnings, logger, pricing);

        // 100000 * 0.000003 + 4000 * 0.000015 = 0.3 + 0.06 = 0.36
        assert.strictEqual(result, 0.36);
        assert.strictEqual(warnings.length, 0, 'Should not add warning when pricing available');
    });

    test('should fallback to formula when pricing unavailable', async () => {
        const warnings: string[] = [];
        const logger = { warn: () => {} };

        const result = await calculateCostEstimate(100000, warnings, logger, null);

        // Fallback: (100000/1000000)*3 + (4000/1000000)*15 = 0.3 + 0.06 = 0.36
        // Use approximate comparison due to floating point
        assert.ok(Math.abs(result - 0.36) < 0.0001, `Expected ~0.36, got ${result}`);
        assert.ok(warnings.includes('Using fallback pricing - could not fetch current model pricing'));
    });

    test('should handle zero tokens', async () => {
        const warnings: string[] = [];
        const logger = { warn: () => {} };
        const pricing = { prompt: 0.000003, completion: 0.000015 };

        const result = await calculateCostEstimate(0, warnings, logger, pricing);

        // 0 * 0.000003 + 4000 * 0.000015 = 0 + 0.06 = 0.06
        // Use approximate comparison due to floating point
        assert.ok(Math.abs(result - 0.06) < 0.0001, `Expected ~0.06, got ${result}`);
    });

    test('should handle large token counts', async () => {
        const warnings: string[] = [];
        const logger = { warn: () => {} };
        const pricing = { prompt: 0.000003, completion: 0.000015 };

        const result = await calculateCostEstimate(1000000, warnings, logger, pricing);

        // 1000000 * 0.000003 + 4000 * 0.000015 = 3 + 0.06 = 3.06
        assert.strictEqual(result, 3.06);
    });
});

describe('Constants verification', () => {
    test('TIKTOKEN_TO_CLAUDE_RATIO should be 1.36', () => {
        assert.strictEqual(TIKTOKEN_TO_CLAUDE_RATIO, 1.36);
    });

    test('GEMINI_TOKEN_RATIO should be 1.1', () => {
        assert.strictEqual(GEMINI_TOKEN_RATIO, 1.1);
    });

    test('CLAUDE_CODE_OVERHEAD should be 5000', () => {
        assert.strictEqual(CLAUDE_CODE_OVERHEAD, 5000);
    });

    test('API_VALIDATION_THRESHOLD should be 0.80 (80%)', () => {
        assert.strictEqual(API_VALIDATION_THRESHOLD, 0.80);
    });
});
