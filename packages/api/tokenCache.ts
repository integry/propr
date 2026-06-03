import { createHash } from 'node:crypto';
import { createClient, type RedisClientType } from 'redis';
import type { GitHubUser } from './authTypes.js';

let tokenCacheClient: RedisClientType | null = null;

async function getTokenCacheClient(): Promise<RedisClientType | null> {
    if (!tokenCacheClient) {
        const redisHost = process.env.REDIS_HOST || '127.0.0.1';
        const redisPort = process.env.REDIS_PORT || '6379';
        try {
            tokenCacheClient = createClient({ url: `redis://${redisHost}:${redisPort}` }) as RedisClientType;
            tokenCacheClient.on('error', (err) => {
                console.error('Token Cache Redis Client Error', err);
            });
            await tokenCacheClient.connect();
        } catch (err) {
            console.error('Token Cache Redis connection failed:', err);
            tokenCacheClient = null;
            return null;
        }
    }
    return tokenCacheClient;
}

const TOKEN_CACHE_PREFIX = 'propr:bearer:';
const TOKEN_CACHE_TTL_SECONDS = 300;

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

async function getCachedUser(token: string): Promise<GitHubUser | null> {
    try {
        const redis = await getTokenCacheClient();
        if (!redis) return null;
        const cached = await redis.get(`${TOKEN_CACHE_PREFIX}${hashToken(token)}`);
        if (cached) return JSON.parse(cached) as GitHubUser;
    } catch (err) {
        console.error('Token cache read error:', err);
    }
    return null;
}

async function setCachedUser(token: string, user: GitHubUser): Promise<void> {
    try {
        const redis = await getTokenCacheClient();
        if (!redis) return;
        await redis.set(
            `${TOKEN_CACHE_PREFIX}${hashToken(token)}`,
            JSON.stringify(user),
            { EX: TOKEN_CACHE_TTL_SECONDS }
        );
    } catch (err) {
        console.error('Token cache write error:', err);
    }
}

export async function validateGitHubToken(token: string): Promise<GitHubUser | null> {
    const cached = await getCachedUser(token);
    if (cached) return cached;

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

    await setCachedUser(token, user);
    return user;
}
