import Redis from 'ioredis';
import logger from '../utils/logger.js';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';
const PRICING_CACHE_KEY = 'pricing:openrouter:data';
const CACHE_TTL_SECONDS = 86400; // 24 hours

const connectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

export async function getModelPricing(openRouterModelId) {
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
                const data = await response.json();
                
                const pricingMap = {};
                if (data && Array.isArray(data.data)) {
                    data.data.forEach(model => {
                        if (model.pricing) {
                            pricingMap[model.id] = {
                                prompt: parseFloat(model.pricing.prompt) || 0,
                                completion: parseFloat(model.pricing.completion) || 0
                            };
                        }
                    });
                }
                
                pricingData = JSON.stringify(pricingMap);
                await redis.setex(PRICING_CACHE_KEY, CACHE_TTL_SECONDS, pricingData);
                logger.info('Updated OpenRouter pricing cache.');
            } catch (apiError) {
                logger.error({ error: apiError.message }, 'Failed to fetch OpenRouter pricing');
                return null;
            }
        }
        
        const pricingMap = JSON.parse(pricingData);
        return pricingMap[openRouterModelId] || null;

    } catch (error) {
        logger.error({ error: error.message }, 'Error in getModelPricing');
        return null;
    } finally {
        await redis.quit();
    }
}
