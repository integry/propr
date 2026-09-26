import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  getModelPricing,
  getOfficialModelPricing,
} from '../packages/core/src/services/pricingService.js';
import { calculateCostWithCachePricing } from '../packages/core/src/utils/tokenCalculation.js';
import { getOpenRouterId } from '../packages/core/src/config/modelAliases.js';

after(async () => {
  const { db } = await import('../packages/core/src/db/connection.js');
  await db.destroy();
});

describe('provider API pricing', () => {
  test('uses the published Claude Fable 5.1 rates, including prompt cache prices', async () => {
    const pricing = getOfficialModelPricing('anthropic/claude-fable-5.1');

    assert.deepStrictEqual(pricing, {
      prompt: 10 / 1_000_000,
      completion: 50 / 1_000_000,
      cacheCreation: 12.5 / 1_000_000,
      cacheRead: 0.25 / 1_000_000,
    });
    assert.strictEqual(
      await getModelPricing('anthropic/claude-fable-5.1'),
      pricing,
      'official pricing should resolve without relying on the OpenRouter cache',
    );
  });

  test('uses the published Claude Fable 5 rates, including prompt cache prices', () => {
    assert.deepStrictEqual(getOfficialModelPricing('anthropic/claude-fable-5'), {
      prompt: 10 / 1_000_000,
      completion: 50 / 1_000_000,
      cacheCreation: 12.5 / 1_000_000,
      cacheRead: 1 / 1_000_000,
    });
  });

  test('prices alias-configured Fable agents at the Fable rates', () => {
    const expected = {
      fable: 'anthropic/claude-fable-5.1',
      fable51: 'anthropic/claude-fable-5.1',
      'claude-fable': 'anthropic/claude-fable-5.1',
      fable5: 'anthropic/claude-fable-5',
      'fable-5': 'anthropic/claude-fable-5',
    };

    for (const [alias, openRouterId] of Object.entries(expected)) {
      assert.strictEqual(getOpenRouterId(alias), openRouterId, `alias ${alias} should price as ${openRouterId}`);
      assert.deepStrictEqual(
        getOfficialModelPricing(getOpenRouterId(alias)),
        getOfficialModelPricing(openRouterId),
        `alias ${alias} should not fall back to default pricing`,
      );
    }
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

  test('uses the published Claude Opus 5.5 rates, including prompt cache prices', async () => {
    const pricing = getOfficialModelPricing('anthropic/claude-opus-5.5');

    assert.deepStrictEqual(pricing, {
      prompt: 4 / 1_000_000,
      completion: 20 / 1_000_000,
      cacheCreation: 5 / 1_000_000,
      cacheRead: 0.2 / 1_000_000,
    });
    assert.strictEqual(
      await getModelPricing('anthropic/claude-opus-5.5'),
      pricing,
      'official pricing should resolve without relying on the OpenRouter cache',
    );
  });

  test('uses the permanent published Claude Sonnet 5 rates', () => {
    const pricing = getOfficialModelPricing('anthropic/claude-sonnet-5');

    assert.strictEqual(pricing?.prompt, 2 / 1_000_000);
    assert.strictEqual(pricing?.completion, 10 / 1_000_000);
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

    assert.ok(Math.abs(cost - 0.00072) < 1e-12);
  });

  test('uses the published GPT-6 Astra API and cache rates', () => {
    assert.deepStrictEqual(getOfficialModelPricing('openai/gpt-6-astra'), {
      prompt: 10 / 1_000_000,
      completion: 50 / 1_000_000,
      cacheCreation: 12.5 / 1_000_000,
      cacheRead: 1 / 1_000_000,
    });
  });
});
