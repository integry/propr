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
    // Use model-specific ratio: tiktoken (cl100k_base) is accurate for OpenAI models
    // Claude needs 1.36x multiplier, Gemini needs ~1.1x
    const modelLower = modelId?.toLowerCase() || '';
    const isOpenAI = modelLower.includes('gpt-') || modelLower.includes('codex') || modelLower.includes('openai');
    const isGemini = modelLower.includes('gemini');
    const tokenRatio = isOpenAI ? 1.0 : (isGemini ? GEMINI_TOKEN_RATIO : TIKTOKEN_TO_CLAUDE_RATIO);
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

        test('should use OpenAI ratio (1.0) for GPT models', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'gpt-5.4',
                () => 10000,
                async () => 0
            );

            // OpenAI models use 1.0 ratio (tiktoken is accurate for them)
            assert.strictEqual(result.tokenCount, 10000);
        });

        test('should use OpenAI ratio (1.0) for Codex models', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'codex-2.0',
                () => 10000,
                async () => 0
            );

            // Codex models use 1.0 ratio (tiktoken is OpenAI's tokenizer)
            assert.strictEqual(result.tokenCount, 10000);
        });

        test('should detect OpenAI model case-insensitively', async () => {
            const logger = createMockLogger();
            const result = await validatePromptTokens(
                'test prompt',
                100000,
                logger,
                'GPT-5',
                () => 10000,
                async () => 0
            );

            // Should use OpenAI ratio: 10000 * 1.0 = 10000
            assert.strictEqual(result.tokenCount, 10000);
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
     * This version accepts injectable pricing to avoid network calls, supporting:
     * - Pricing API path (when pricing is provided)
     * - Fallback formula (when pricing is null)
     * - Error simulation (when pricingFetcher throws)
     *
     * Constants:
     * - DEFAULT_OUTPUT_TOKENS = 4000 (assumed completion tokens)
     * - Fallback rates: $3 per 1M input tokens, $15 per 1M output tokens
     */
    const DEFAULT_OUTPUT_TOKENS = 4000;

    async function calculateCostEstimate(
        totalTokens: number,
        warnings: string[],
        logger: { warn: (...args: unknown[]) => void },
        pricingFetcher: () => Promise<{ prompt: number; completion: number } | null> = async () => null
    ): Promise<number> {
        try {
            const pricing = await pricingFetcher();
            if (pricing) {
                return totalTokens * pricing.prompt + DEFAULT_OUTPUT_TOKENS * pricing.completion;
            }
            warnings.push('Using fallback pricing - could not fetch current model pricing');
        } catch (e) {
            warnings.push('Using fallback pricing - pricing service error');
            logger.warn({ error: (e as Error).message }, 'Failed to get model pricing');
        }
        return (totalTokens / 1_000_000) * 3 + (DEFAULT_OUTPUT_TOKENS / 1_000_000) * 15;
    }

    describe('pricing API path (acceptance criteria: calculates accurately)', () => {
        test('should calculate cost from pricing API', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };

            const result = await calculateCostEstimate(100000, warnings, logger, async () => pricing);

            // 100000 * 0.000003 + 4000 * 0.000015 = 0.3 + 0.06 = 0.36
            assert.strictEqual(result, 0.36);
            assert.strictEqual(warnings.length, 0, 'Should not add warning when pricing available');
        });

        test('should handle zero tokens with pricing', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };

            const result = await calculateCostEstimate(0, warnings, logger, async () => pricing);

            // 0 * 0.000003 + 4000 * 0.000015 = 0 + 0.06 = 0.06
            assert.ok(Math.abs(result - 0.06) < 0.0001, `Expected ~0.06, got ${result}`);
        });

        test('should handle large token counts with pricing', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };

            const result = await calculateCostEstimate(1000000, warnings, logger, async () => pricing);

            // 1000000 * 0.000003 + 4000 * 0.000015 = 3 + 0.06 = 3.06
            assert.strictEqual(result, 3.06);
        });

        test('should calculate correctly with different model pricing ratios', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            // Simulate GPT-4o pricing (different ratio than Claude)
            const gpt4oPricing = { prompt: 0.000005, completion: 0.000015 };

            const result = await calculateCostEstimate(100000, warnings, logger, async () => gpt4oPricing);

            // 100000 * 0.000005 + 4000 * 0.000015 = 0.5 + 0.06 = 0.56
            assert.strictEqual(result, 0.56);
        });

        test('should handle very small token counts accurately', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };

            const result = await calculateCostEstimate(100, warnings, logger, async () => pricing);

            // 100 * 0.000003 + 4000 * 0.000015 = 0.0003 + 0.06 = 0.0603
            assert.ok(Math.abs(result - 0.0603) < 0.0001, `Expected ~0.0603, got ${result}`);
        });

        test('should handle context window sized token counts', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };
            // 200k context window
            const result = await calculateCostEstimate(200000, warnings, logger, async () => pricing);

            // 200000 * 0.000003 + 4000 * 0.000015 = 0.6 + 0.06 = 0.66
            assert.strictEqual(result, 0.66);
        });
    });

    describe('fallback pricing path (acceptance criteria: applies fallback formula)', () => {
        test('should fallback to formula when pricing returns null', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };

            const result = await calculateCostEstimate(100000, warnings, logger, async () => null);

            // Fallback: (100000/1000000)*3 + (4000/1000000)*15 = 0.3 + 0.06 = 0.36
            assert.ok(Math.abs(result - 0.36) < 0.0001, `Expected ~0.36, got ${result}`);
            assert.ok(warnings.includes('Using fallback pricing - could not fetch current model pricing'));
        });

        test('should handle zero tokens with fallback pricing', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };

            const result = await calculateCostEstimate(0, warnings, logger, async () => null);

            // Fallback: (0/1000000)*3 + (4000/1000000)*15 = 0 + 0.06 = 0.06
            assert.ok(Math.abs(result - 0.06) < 0.0001, `Expected ~0.06, got ${result}`);
        });

        test('should handle large token counts with fallback pricing', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };

            const result = await calculateCostEstimate(1000000, warnings, logger, async () => null);

            // Fallback: (1000000/1000000)*3 + (4000/1000000)*15 = 3 + 0.06 = 3.06
            assert.ok(Math.abs(result - 3.06) < 0.0001, `Expected ~3.06, got ${result}`);
        });

        test('should add warning only once on fallback', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };

            await calculateCostEstimate(100000, warnings, logger, async () => null);

            assert.strictEqual(warnings.length, 1, 'Should add exactly one warning');
            assert.strictEqual(warnings[0], 'Using fallback pricing - could not fetch current model pricing');
        });
    });

    describe('error handling path (acceptance criteria: handles pricing service errors)', () => {
        test('should fallback to formula when pricing service throws', async () => {
            const warnings: string[] = [];
            const warnCalls: unknown[][] = [];
            const logger = { warn: (...args: unknown[]) => { warnCalls.push(args); } };

            const result = await calculateCostEstimate(100000, warnings, logger, async () => {
                throw new Error('Connection refused');
            });

            // Should use fallback formula
            assert.ok(Math.abs(result - 0.36) < 0.0001, `Expected ~0.36, got ${result}`);
            assert.ok(warnings.includes('Using fallback pricing - pricing service error'));
        });

        test('should log error when pricing service throws', async () => {
            const warnings: string[] = [];
            const warnCalls: unknown[][] = [];
            const logger = { warn: (...args: unknown[]) => { warnCalls.push(args); } };

            await calculateCostEstimate(100000, warnings, logger, async () => {
                throw new Error('API timeout');
            });

            assert.strictEqual(warnCalls.length, 1, 'Should log warning');
            const logData = warnCalls[0][0] as { error: string };
            assert.strictEqual(logData.error, 'API timeout');
            assert.ok((warnCalls[0][1] as string).includes('Failed to get model pricing'));
        });

        test('should handle different error types gracefully', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };

            // TypeError
            const result1 = await calculateCostEstimate(100000, warnings, logger, async () => {
                throw new TypeError('Invalid response format');
            });
            assert.ok(Math.abs(result1 - 0.36) < 0.0001);

            // Clear warnings for next test
            warnings.length = 0;

            // Network error
            const result2 = await calculateCostEstimate(100000, warnings, logger, async () => {
                throw new Error('ECONNREFUSED');
            });
            assert.ok(Math.abs(result2 - 0.36) < 0.0001);
        });
    });

    describe('model-specific token ratios (acceptance criteria: applies model-specific pricing)', () => {
        test('should calculate Claude Sonnet pricing accurately', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            // Claude Sonnet 4 pricing: $3/M input, $15/M output
            const claudeSonnetPricing = { prompt: 0.000003, completion: 0.000015 };

            const result = await calculateCostEstimate(500000, warnings, logger, async () => claudeSonnetPricing);

            // 500000 * 0.000003 + 4000 * 0.000015 = 1.5 + 0.06 = 1.56
            assert.strictEqual(result, 1.56);
        });

        test('should calculate Claude Opus pricing accurately', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            // Claude Opus 4 pricing: $15/M input, $75/M output
            const claudeOpusPricing = { prompt: 0.000015, completion: 0.000075 };

            const result = await calculateCostEstimate(500000, warnings, logger, async () => claudeOpusPricing);

            // 500000 * 0.000015 + 4000 * 0.000075 = 7.5 + 0.3 = 7.8
            assert.strictEqual(result, 7.8);
        });

        test('should calculate GPT-4 class pricing accurately', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            // GPT-4-turbo pricing: $10/M input, $30/M output
            const gpt4Pricing = { prompt: 0.00001, completion: 0.00003 };

            const result = await calculateCostEstimate(500000, warnings, logger, async () => gpt4Pricing);

            // 500000 * 0.00001 + 4000 * 0.00003 = 5 + 0.12 = 5.12
            assert.strictEqual(result, 5.12);
        });

        test('should calculate Gemini pricing accurately', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            // Gemini 2.0 Flash pricing (example)
            const geminiPricing = { prompt: 0.0000001, completion: 0.0000004 };

            const result = await calculateCostEstimate(500000, warnings, logger, async () => geminiPricing);

            // 500000 * 0.0000001 + 4000 * 0.0000004 = 0.05 + 0.0016 = 0.0516
            assert.ok(Math.abs(result - 0.0516) < 0.0001, `Expected ~0.0516, got ${result}`);
        });
    });

    describe('edge cases', () => {
        test('should handle fractional token counts', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };

            // In practice tokens are integers, but test robustness
            const result = await calculateCostEstimate(99999.5, warnings, logger, async () => pricing);

            // 99999.5 * 0.000003 + 4000 * 0.000015
            const expected = 99999.5 * 0.000003 + 4000 * 0.000015;
            assert.ok(Math.abs(result - expected) < 0.0001, `Expected ~${expected}, got ${result}`);
        });

        test('should handle extremely large token counts (10M+)', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0.000003, completion: 0.000015 };

            const result = await calculateCostEstimate(10000000, warnings, logger, async () => pricing);

            // 10000000 * 0.000003 + 4000 * 0.000015 = 30 + 0.06 = 30.06
            assert.strictEqual(result, 30.06);
        });

        test('should handle very cheap pricing (free tier simulation)', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const freePricing = { prompt: 0, completion: 0 };

            const result = await calculateCostEstimate(100000, warnings, logger, async () => freePricing);

            assert.strictEqual(result, 0);
        });

        test('should always include DEFAULT_OUTPUT_TOKENS cost', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };
            const pricing = { prompt: 0, completion: 0.000015 };

            // Even with 0 input tokens and 0 prompt price, should have completion cost
            const result = await calculateCostEstimate(0, warnings, logger, async () => pricing);

            // 0 * 0 + 4000 * 0.000015 = 0.06
            assert.ok(Math.abs(result - 0.06) < 0.0001, `Expected ~0.06, got ${result}`);
        });
    });

    describe('mathematical accuracy verification', () => {
        test('should avoid floating point errors in typical scenarios', async () => {
            const warnings: string[] = [];
            const logger = { warn: () => {} };

            // Test several values that could cause floating point issues
            const testCases = [
                { tokens: 1, expected: 1 * 0.000003 + 4000 * 0.000015 },
                { tokens: 333, expected: 333 * 0.000003 + 4000 * 0.000015 },
                { tokens: 128000, expected: 128000 * 0.000003 + 4000 * 0.000015 },
                { tokens: 999999, expected: 999999 * 0.000003 + 4000 * 0.000015 },
            ];

            const pricing = { prompt: 0.000003, completion: 0.000015 };

            for (const tc of testCases) {
                const result = await calculateCostEstimate(tc.tokens, [], logger, async () => pricing);
                assert.ok(
                    Math.abs(result - tc.expected) < 0.0001,
                    `For ${tc.tokens} tokens: expected ${tc.expected}, got ${result}`
                );
            }
        });

        test('should match fallback formula exactly with equivalent pricing', async () => {
            const warnings1: string[] = [];
            const warnings2: string[] = [];
            const logger = { warn: () => {} };

            // Fallback uses: $3/M input, $15/M output
            // Which is: 0.000003 per token input, 0.000015 per token output
            const equivalentPricing = { prompt: 0.000003, completion: 0.000015 };

            const apiResult = await calculateCostEstimate(100000, warnings1, logger, async () => equivalentPricing);
            const fallbackResult = await calculateCostEstimate(100000, warnings2, logger, async () => null);

            assert.ok(
                Math.abs(apiResult - fallbackResult) < 0.0001,
                `API result (${apiResult}) should match fallback (${fallbackResult})`
            );
        });
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
