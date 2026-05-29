import crypto from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import type { GitHubUser } from './authTypes.js';

let tokenCacheClient: RedisClientType | null = null;
let tokenCacheConnectPromise: Promise<RedisClientType> | null = null;

type CachedGitHubUser = Omit<GitHubUser, 'accessToken'>;

async function getTokenCacheClient(): Promise<RedisClientType> {
    if (tokenCacheClient?.isOpen) {
        return tokenCacheClient;
    }
    if (!tokenCacheConnectPromise) {
        const redisHost = process.env.REDIS_HOST || '127.0.0.1';
        const redisPort = process.env.REDIS_PORT || '6379';
        const client = createClient({ url: `redis://${redisHost}:${redisPort}` }) as RedisClientType;
        client.on('error', (err) => {
            console.error('Token Cache Redis Client Error', err);
        });
        tokenCacheConnectPromise = client.connect()
            .then(() => {
                tokenCacheClient = client;
                tokenCacheConnectPromise = null;
                return client;
            })
            .catch(error => {
                tokenCacheClient = null;
                tokenCacheConnectPromise = null;
                throw error;
            });
    }
    return tokenCacheConnectPromise;
}

const TOKEN_CACHE_PREFIX = 'propr:bearer:';
const TOKEN_CACHE_TTL_SECONDS = 300;

function getTokenCacheKey(token: string): string {
    return `${TOKEN_CACHE_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export async function validateGitHubToken(token: string): Promise<GitHubUser | null> {
    try {
        const redis = await getTokenCacheClient();
        const cacheKey = getTokenCacheKey(token);
        const cached = await redis.get(cacheKey);
        if (cached) {
            return { ...(JSON.parse(cached) as CachedGitHubUser), accessToken: token };
        }

        const response = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ProPR-CLI',
            },
        });
        if (!response.ok) {
            return null;
        }

        const profile = await response.json() as {
            id: number;
            login: string;
            name: string | null;
            email: string | null;
            avatar_url: string | null;
        };
        const user: GitHubUser = {
            id: String(profile.id),
            login: profile.login,
            username: profile.login,
            displayName: profile.name || profile.login,
            email: profile.email,
            avatarUrl: profile.avatar_url,
            accessToken: token,
        };

        const cacheableUser: CachedGitHubUser = {
            id: user.id,
            login: user.login,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            avatarUrl: user.avatarUrl
        };
        await redis.set(cacheKey, JSON.stringify(cacheableUser), { EX: TOKEN_CACHE_TTL_SECONDS });
        return user;
    } catch (error) {
        console.error('Bearer token validation error:', error);
        return null;
    }
}
