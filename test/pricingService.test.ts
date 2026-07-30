import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  getModelPricing,
  getOfficialModelPricing,
} from '../packages/core/src/services/pricingService.js';
import { calculateCostWithCachePricing } from '../packages/core/src/utils/tokenCalculation.js';

after(async () => {
  const { db } = await import('../packages/core/src/db/connection.js');
  await db.destroy();
});

describe('provider API pricing', () => {
  test('uses the published Claude Fable 5 rates, including prompt cache prices', async () => {
    const pricing = getOfficialModelPricing('anthropic/claude-fable-5');

    assert.deepStrictEqual(pricing, {
      prompt: 10 / 1_000_000,
      completion: 50 / 1_000_000,
      cacheCreation: 12.5 / 1_000_000,
      cacheRead: 1 / 1_000_000,
    });
    assert.strictEqual(
      await getModelPricing('anthropic/claude-fable-5'),
      pricing,
      'official pricing should resolve without relying on the OpenRouter cache',
    );
  });

  test('prices a cache-heavy Fable run using each reported token category', () => {
    const pricing = getOfficialModelPricing('anthropic/claude-fable-5');
    assert.ok(pricing);

    const cost = calculateCostWithCachePricing('claude-fable-5', {
      inputTokens: 355,
      outputTokens: 132_540,
      cacheCreationTokens: 293_413,
      cacheReadTokens: 31_285_815,
      totalInputWithCache: 31_579_583,
      totalTokens: 31_712_123,
    }, pricing);

    assert.ok(Math.abs(cost - 41.5840275) < 1e-10);
  });

  test('applies the published Claude Sonnet 5 promotional period', () => {
    const promotional = getOfficialModelPricing(
      'anthropic/claude-sonnet-5',
      new Date('2026-08-31T23:59:59Z'),
    );
    const standard = getOfficialModelPricing(
      'anthropic/claude-sonnet-5',
      new Date('2026-09-01T00:00:00Z'),
    );

    assert.strictEqual(promotional?.prompt, 2 / 1_000_000);
    assert.strictEqual(promotional?.completion, 10 / 1_000_000);
    assert.strictEqual(standard?.prompt, 3 / 1_000_000);
    assert.strictEqual(standard?.completion, 15 / 1_000_000);
  });

  test('uses model-specific OpenAI cached-input pricing', () => {
    const pricing = getOfficialModelPricing('openai/gpt-5.6-sol');
    assert.ok(pricing);

    const cost = calculateCostWithCachePricing('gpt-5.6-sol', {
      inputTokens: 50,
      outputTokens: 25,
      cacheCreationTokens: 0,
      cacheReadTokens: 50,
      totalInputWithCache: 100,
      totalTokens: 125,
    }, pricing);

    assert.ok(Math.abs(cost - 0.001025) < 1e-12);
  });
});
