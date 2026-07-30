import { Redis } from 'ioredis';
import logger from '../utils/logger.js';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';
const PRICING_CACHE_KEY = 'pricing:openrouter:v2:data';
const CACHE_TTL_SECONDS = 86400;
const SONNET_5_PROMOTIONAL_PRICING_END = Date.UTC(2026, 8, 1);

interface RedisConnectionOptions {
    host: string;
    port: number;
    maxRetriesPerRequest: number;
    enableReadyCheck: boolean;
}

const connectionOptions: RedisConnectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
};

export interface ModelPricing {
    prompt: number;
    completion: number;
    cacheRead?: number;
    cacheCreation?: number;
}

interface OpenRouterModel {
    id: string;
    pricing?: {
        prompt?: string;
        completion?: string;
        input_cache_read?: string;
        input_cache_write?: string;
    };
}

interface OpenRouterResponse {
    data?: OpenRouterModel[];
}

const perMillion = (price: number): number => price / 1_000_000;

/**
 * First-party API prices for the models directly supported by ProPR.
 *
 * OpenRouter remains the fallback for community and routed models, but its prices
 * can describe OpenRouter-specific routing rather than the provider API used by a
 * coding agent. Keep these rates aligned with the provider pricing pages.
 *
 * Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * OpenAI: https://developers.openai.com/api/docs/models/compare
 */
const OFFICIAL_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
    'anthropic/claude-fable-5': {
        prompt: perMillion(10), completion: perMillion(50),
        cacheCreation: perMillion(12.5), cacheRead: perMillion(1)
    },
    'anthropic/claude-opus-5': {
        prompt: perMillion(5), completion: perMillion(25),
        cacheCreation: perMillion(6.25), cacheRead: perMillion(0.5)
    },
    'anthropic/claude-opus-4.8': {
        prompt: perMillion(5), completion: perMillion(25),
        cacheCreation: perMillion(6.25), cacheRead: perMillion(0.5)
    },
    'anthropic/claude-opus-4.7': {
        prompt: perMillion(5), completion: perMillion(25),
        cacheCreation: perMillion(6.25), cacheRead: perMillion(0.5)
    },
    'anthropic/claude-opus-4.6': {
        prompt: perMillion(5), completion: perMillion(25),
        cacheCreation: perMillion(6.25), cacheRead: perMillion(0.5)
    },
    'anthropic/claude-opus-4.5': {
        prompt: perMillion(5), completion: perMillion(25),
        cacheCreation: perMillion(6.25), cacheRead: perMillion(0.5)
    },
    'anthropic/claude-sonnet-5': {
        prompt: perMillion(3), completion: perMillion(15),
        cacheCreation: perMillion(3.75), cacheRead: perMillion(0.3)
    },
    'anthropic/claude-sonnet-4.6': {
        prompt: perMillion(3), completion: perMillion(15),
        cacheCreation: perMillion(3.75), cacheRead: perMillion(0.3)
    },
    'anthropic/claude-sonnet-4.5': {
        prompt: perMillion(3), completion: perMillion(15),
        cacheCreation: perMillion(3.75), cacheRead: perMillion(0.3)
    },
    'anthropic/claude-haiku-4.5': {
        prompt: perMillion(1), completion: perMillion(5),
        cacheCreation: perMillion(1.25), cacheRead: perMillion(0.1)
    },
    'openai/gpt-5.6-sol': {
        prompt: perMillion(5), completion: perMillion(30),
        cacheCreation: perMillion(5), cacheRead: perMillion(0.5)
    },
    'openai/gpt-5.6-terra': {
        prompt: perMillion(2.5), completion: perMillion(15),
        cacheCreation: perMillion(2.5), cacheRead: perMillion(0.25)
    },
    'openai/gpt-5.6-luna': {
        prompt: perMillion(1), completion: perMillion(6),
        cacheCreation: perMillion(1), cacheRead: perMillion(0.1)
    },
    'openai/gpt-5.5': {
        prompt: perMillion(5), completion: perMillion(30),
        cacheCreation: perMillion(5), cacheRead: perMillion(0.5)
    },
    'openai/gpt-5.5-pro': {
        prompt: perMillion(30), completion: perMillion(180)
    },
    'openai/gpt-5.4': {
        prompt: perMillion(2.5), completion: perMillion(15),
        cacheCreation: perMillion(2.5), cacheRead: perMillion(0.25)
    },
    'openai/gpt-5.4-pro': {
        prompt: perMillion(30), completion: perMillion(180)
    },
    'openai/gpt-5.4-mini': {
        prompt: perMillion(0.75), completion: perMillion(4.5),
        cacheCreation: perMillion(0.75), cacheRead: perMillion(0.075)
    },
    'openai/gpt-5.4-nano': {
        prompt: perMillion(0.2), completion: perMillion(1.25),
        cacheCreation: perMillion(0.2), cacheRead: perMillion(0.02)
    },
    'openai/gpt-5.3-codex': {
        prompt: perMillion(1.75), completion: perMillion(14),
        cacheCreation: perMillion(1.75), cacheRead: perMillion(0.175)
    },
    'openai/gpt-5.2': {
        prompt: perMillion(1.75), completion: perMillion(14),
        cacheCreation: perMillion(1.75), cacheRead: perMillion(0.175)
    },
    'openai/gpt-5-mini': {
        prompt: perMillion(0.25), completion: perMillion(2),
        cacheCreation: perMillion(0.25), cacheRead: perMillion(0.025)
    },
    'openai/gpt-5-nano': {
        prompt: perMillion(0.05), completion: perMillion(0.4),
        cacheCreation: perMillion(0.05), cacheRead: perMillion(0.005)
    }
};

const SONNET_5_PROMOTIONAL_PRICING: ModelPricing = {
    prompt: perMillion(2), completion: perMillion(10),
    cacheCreation: perMillion(2.5), cacheRead: perMillion(0.2)
};

export function getOfficialModelPricing(modelId: string, at: Date = new Date()): ModelPricing | null {
    if (modelId === 'anthropic/claude-sonnet-5' && at.getTime() < SONNET_5_PROMOTIONAL_PRICING_END) {
        return SONNET_5_PROMOTIONAL_PRICING;
    }
    return OFFICIAL_MODEL_PRICING[modelId] ?? null;
}

function parseOptionalPrice(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export async function getModelPricing(openRouterModelId: string): Promise<ModelPricing | null> {
    const officialPricing = getOfficialModelPricing(openRouterModelId);
    if (officialPricing) return officialPricing;

    const redis = new Redis(connectionOptions);

    try {
        let pricingData = await redis.get(PRICING_CACHE_KEY);

        if (!pricingData) {
            logger.info('Pricing cache miss. Fetching from OpenRouter API...');
            try {
                const response = await fetch(OPENROUTER_API_URL);
                if (!response.ok) {
                    throw new Error(`OpenRouter API error: ${response.statusText}`);
                }
                const data: OpenRouterResponse = await response.json() as OpenRouterResponse;

                const pricingMap: Record<string, ModelPricing> = {};
                if (data && Array.isArray(data.data)) {
                    data.data.forEach((model: OpenRouterModel) => {
                        if (model.pricing) {
                            const cacheRead = parseOptionalPrice(model.pricing.input_cache_read);
                            const cacheCreation = parseOptionalPrice(model.pricing.input_cache_write);
                            pricingMap[model.id] = {
                                prompt: parseFloat(model.pricing.prompt || '0') || 0,
                                completion: parseFloat(model.pricing.completion || '0') || 0,
                                ...(cacheRead !== undefined && { cacheRead }),
                                ...(cacheCreation !== undefined && { cacheCreation })
                            };
                        }
                    });
                }

                pricingData = JSON.stringify(pricingMap);
                await redis.setex(PRICING_CACHE_KEY, CACHE_TTL_SECONDS, pricingData);
                logger.info('Updated OpenRouter pricing cache.');
            } catch (apiError) {
                logger.error({ error: (apiError as Error).message }, 'Failed to fetch OpenRouter pricing');
                return null;
            }
        }

        const pricingMap: Record<string, ModelPricing> = JSON.parse(pricingData);
        return pricingMap[openRouterModelId] || null;

    } catch (error) {
        logger.error({ error: (error as Error).message }, 'Error in getModelPricing');
        return null;
    } finally {
        await redis.quit();
    }
}
