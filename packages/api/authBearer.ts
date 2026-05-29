import { createClient, type RedisClientType } from 'redis';
import type { GitHubUser } from './authTypes.js';

let tokenCacheClient: RedisClientType | null = null;

async function getTokenCacheClient(): Promise<RedisClientType> {
    if (!tokenCacheClient) {
        const redisHost = process.env.REDIS_HOST || '127.0.0.1';
        const redisPort = process.env.REDIS_PORT || '6379';
        tokenCacheClient = createClient({ url: `redis://${redisHost}:${redisPort}` }) as RedisClientType;
        tokenCacheClient.on('error', (err) => {
            console.error('Token Cache Redis Client Error', err);
        });
        await tokenCacheClient.connect();
    }
    return tokenCacheClient;
}

const TOKEN_CACHE_PREFIX = 'propr:bearer:';
const TOKEN_CACHE_TTL_SECONDS = 300;

export async function validateGitHubToken(token: string): Promise<GitHubUser | null> {
    try {
        const redis = await getTokenCacheClient();
        const cached = await redis.get(`${TOKEN_CACHE_PREFIX}${token}`);
        if (cached) {
            return JSON.parse(cached) as GitHubUser;
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

        await redis.set(`${TOKEN_CACHE_PREFIX}${token}`, JSON.stringify(user), { EX: TOKEN_CACHE_TTL_SECONDS });
        return user;
    } catch (error) {
        console.error('Bearer token validation error:', error);
        return null;
    }
}
