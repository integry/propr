/**
 * Cache of GitHub user profiles keyed by the stable numeric user id.
 *
 * Work is stored against a GitHub numeric user id; this service maps those ids
 * to the login and avatar an assignee is rendered with. Profiles are remembered
 * whenever a GitHub payload already carries them, and gaps or stale entries are
 * filled from `GET /user/{account_id}`.
 *
 * Every function fails soft: an unreadable cache or a GitHub outage yields
 * whatever is known rather than an error, because assignment display must never
 * break a task list.
 */

import type { AttributedUser } from '@propr/shared';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';

export type { AttributedUser } from '@propr/shared';

const TABLE = 'github_user_profiles';

/** How long a refreshed profile is served from the cache before GitHub is asked again. */
export const GITHUB_USER_PROFILE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Upper bound on GitHub lookups a single resolve call makes. */
export const GITHUB_USER_PROFILE_MAX_FETCHES = 50;
// Stay well below SQLite's bound-parameter limit on batch reads.
const READ_CHUNK_SIZE = 500;

/**
 * A profile observed in a GitHub payload. Accepts the REST/webhook user object
 * (`avatar_url`, `name`) or the camel-cased contract fields. A field that is
 * absent leaves the cached value alone, since webhook user objects omit `name`.
 */
export interface GitHubUserProfileInput {
    id: string | number;
    login: string;
    avatar_url?: string | null;
    avatarUrl?: string | null;
    name?: string | null;
    displayName?: string | null;
}

export interface GitHubUserProfileRow {
    github_user_id: string;
    login: string;
    avatar_url: string | null;
    display_name: string | null;
    refreshed_at: string;
    created_at: string;
    updated_at: string;
}

/** The narrow slice of Octokit this service calls; injectable for tests. */
export interface GitHubUserProfileClient {
    request(route: string, parameters: Record<string, string | number>): Promise<{ data: unknown }>;
}

export interface ResolveGitHubUserProfilesOptions {
    /** Defaults to the installation's authenticated Octokit. */
    github?: GitHubUserProfileClient;
    staleAfterMs?: number;
    maxFetches?: number;
    now?: () => Date;
}

interface NormalizedProfile {
    id: string;
    login: string;
    avatarUrl?: string | null;
    displayName?: string | null;
}

function normalizeUserId(value: unknown): string | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value.trim())) return value.trim();
    return null;
}

function optionalString(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function normalizeProfile(input: unknown): NormalizedProfile | null {
    if (!input || typeof input !== 'object') return null;
    const record = input as Record<string, unknown>;
    const id = normalizeUserId(record.id);
    const login = typeof record.login === 'string' ? record.login.trim() : '';
    if (!id || !login) return null;
    const avatarUrl = optionalString(record.avatar_url !== undefined ? record.avatar_url : record.avatarUrl);
    const displayName = optionalString(record.name !== undefined ? record.name : record.displayName);
    return { id, login, avatarUrl, displayName };
}

function toAttributedUser(row: GitHubUserProfileRow): AttributedUser {
    return { id: row.github_user_id, login: row.login, displayName: row.display_name ?? null, avatarUrl: row.avatar_url ?? null };
}

function uniqueUserIds(userIds: Iterable<string | number | null | undefined>): string[] {
    const ids = new Set<string>();
    for (const value of userIds) {
        const id = normalizeUserId(value);
        if (id) ids.add(id);
    }
    return [...ids];
}

async function readRows(ids: string[]): Promise<GitHubUserProfileRow[]> {
    const rows: GitHubUserProfileRow[] = [];
    for (let start = 0; start < ids.length; start += READ_CHUNK_SIZE) {
        rows.push(...await db<GitHubUserProfileRow>(TABLE).whereIn('github_user_id', ids.slice(start, start + READ_CHUNK_SIZE)));
    }
    return rows;
}

async function writeProfiles(profiles: NormalizedProfile[], now: Date): Promise<number> {
    if (profiles.length === 0) return 0;
    const timestamp = now.toISOString();
    await db.transaction(async trx => {
        for (const profile of profiles) {
            const update: Partial<GitHubUserProfileRow> = { login: profile.login, refreshed_at: timestamp, updated_at: timestamp };
            if (profile.avatarUrl !== undefined) update.avatar_url = profile.avatarUrl;
            if (profile.displayName !== undefined) update.display_name = profile.displayName;
            await trx<GitHubUserProfileRow>(TABLE)
                .insert({
                    github_user_id: profile.id,
                    login: profile.login,
                    avatar_url: profile.avatarUrl ?? null,
                    display_name: profile.displayName ?? null,
                    refreshed_at: timestamp,
                    created_at: timestamp,
                    updated_at: timestamp,
                })
                .onConflict('github_user_id')
                .merge(update);
        }
    });
    return profiles.length;
}

/**
 * Idempotently upserts profiles already observed in a GitHub payload. Entries
 * without a numeric id and a login are ignored; the last entry for an id wins.
 * Returns how many profiles were written, or 0 when the cache is unwritable.
 */
export async function rememberGitHubUserProfiles(profiles: Iterable<GitHubUserProfileInput | null | undefined>, now: Date = new Date()): Promise<number> {
    const byId = new Map<string, NormalizedProfile>();
    for (const input of profiles) {
        const profile = normalizeProfile(input);
        if (profile) byId.set(profile.id, profile);
    }
    try {
        return await writeProfiles([...byId.values()], now);
    } catch (error) {
        logger.warn({ error: (error as Error).message, count: byId.size }, 'Failed to remember GitHub user profiles');
        return 0;
    }
}

/** Batch-reads cached profiles. Never calls GitHub; ids not cached are absent from the map. */
export async function loadGitHubUserProfiles(userIds: Iterable<string | number | null | undefined>): Promise<Map<string, AttributedUser>> {
    const profiles = new Map<string, AttributedUser>();
    const ids = uniqueUserIds(userIds);
    if (ids.length === 0) return profiles;
    try {
        for (const row of await readRows(ids)) profiles.set(row.github_user_id, toAttributedUser(row));
    } catch (error) {
        logger.warn({ error: (error as Error).message, count: ids.length }, 'Failed to load cached GitHub user profiles');
    }
    return profiles;
}

function isNotFound(error: unknown): boolean {
    return (error as { status?: unknown } | null)?.status === 404;
}

async function fetchFromGitHub(github: GitHubUserProfileClient, route: string, parameters: Record<string, string | number>, context: string): Promise<NormalizedProfile | null> {
    try {
        const response = await withRetry(() => github.request(route, parameters), retryConfigs.githubApi, context);
        return normalizeProfile(response.data);
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

async function defaultClient(): Promise<GitHubUserProfileClient> {
    return await getAuthenticatedOctokit() as unknown as GitHubUserProfileClient;
}

function isFresh(row: GitHubUserProfileRow, now: Date, staleAfterMs: number): boolean {
    const refreshed = Date.parse(row.refreshed_at);
    return Number.isFinite(refreshed) && now.getTime() - refreshed < staleAfterMs;
}

async function readCachedRows(ids: string[]): Promise<Map<string, GitHubUserProfileRow>> {
    const cached = new Map<string, GitHubUserProfileRow>();
    try {
        for (const row of await readRows(ids)) cached.set(row.github_user_id, row);
    } catch (error) {
        logger.warn({ error: (error as Error).message, count: ids.length }, 'Failed to read cached GitHub user profiles');
    }
    return cached;
}

// Fetches ids one at a time; the first failure (an outage or rate limit) ends
// the batch and keeps what was resolved so far.
async function fetchProfilesById(ids: string[], client: GitHubUserProfileClient | undefined): Promise<NormalizedProfile[]> {
    const fetched: NormalizedProfile[] = [];
    try {
        const github = client ?? await defaultClient();
        for (const id of ids) {
            const profile = await fetchFromGitHub(github, 'GET /user/{account_id}', { account_id: Number(id) }, 'resolve GitHub user profile');
            if (profile && profile.id === id) fetched.push(profile);
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message, pending: ids.length, resolved: fetched.length }, 'Failed to resolve GitHub user profiles; serving cached entries');
    }
    return fetched;
}

/**
 * Batch-reads profiles, filling unknown or stale ids from GitHub and caching
 * the result. Profiles refreshed inside the staleness window are served from
 * the cache. A GitHub failure stops further lookups for this call and returns
 * the cached entries (stale ones included) instead of rejecting.
 */
export async function resolveGitHubUserProfiles(
    userIds: Iterable<string | number | null | undefined>,
    options: ResolveGitHubUserProfilesOptions = {},
): Promise<Map<string, AttributedUser>> {
    const now = options.now?.() ?? new Date();
    const staleAfterMs = options.staleAfterMs ?? GITHUB_USER_PROFILE_STALE_AFTER_MS;
    const maxFetches = options.maxFetches ?? GITHUB_USER_PROFILE_MAX_FETCHES;
    const ids = uniqueUserIds(userIds);
    const profiles = new Map<string, AttributedUser>();
    if (ids.length === 0) return profiles;

    const cached = await readCachedRows(ids);
    for (const row of cached.values()) profiles.set(row.github_user_id, toAttributedUser(row));

    const pending = ids.filter(id => {
        const row = cached.get(id);
        return !row || !isFresh(row, now, staleAfterMs);
    }).slice(0, maxFetches);
    if (pending.length === 0) return profiles;

    const fetched = await fetchProfilesById(pending, options.github);
    for (const profile of fetched) {
        const row = cached.get(profile.id);
        profiles.set(profile.id, {
            id: profile.id,
            login: profile.login,
            displayName: profile.displayName !== undefined ? profile.displayName : row?.display_name ?? null,
            avatarUrl: profile.avatarUrl !== undefined ? profile.avatarUrl : row?.avatar_url ?? null,
        });
    }
    await rememberGitHubUserProfiles(fetched, now);
    return profiles;
}

/**
 * Resolves an operator-supplied login to a profile with a stable id. A fresh
 * cached entry is used when one exists; otherwise GitHub is asked and the
 * result cached. Returns null when the login is unknown or cannot be resolved.
 */
export async function resolveGitHubUserProfileByLogin(
    login: string,
    options: ResolveGitHubUserProfilesOptions = {},
): Promise<AttributedUser | null> {
    const wanted = typeof login === 'string' ? login.trim().replace(/^@/, '') : '';
    if (!wanted) return null;
    const now = options.now?.() ?? new Date();
    const staleAfterMs = options.staleAfterMs ?? GITHUB_USER_PROFILE_STALE_AFTER_MS;

    let cached: GitHubUserProfileRow | undefined;
    try {
        // A renamed account can leave an older row holding the same login, in any
        // case; the most recently refreshed of all matching rows is the current holder.
        cached = await db<GitHubUserProfileRow>(TABLE).whereRaw('LOWER(login) = ?', [wanted.toLowerCase()]).orderBy('refreshed_at', 'desc').first();
    } catch (error) {
        logger.warn({ error: (error as Error).message, login: wanted }, 'Failed to read cached GitHub user profile by login');
    }
    if (cached && isFresh(cached, now, staleAfterMs)) return toAttributedUser(cached);

    try {
        const github = options.github ?? await defaultClient();
        const profile = await fetchFromGitHub(github, 'GET /users/{username}', { username: wanted }, 'resolve GitHub user profile by login');
        if (!profile) return null;
        await rememberGitHubUserProfiles([profile], now);
        return { id: profile.id, login: profile.login, displayName: profile.displayName ?? null, avatarUrl: profile.avatarUrl ?? null };
    } catch (error) {
        logger.warn({ error: (error as Error).message, login: wanted }, 'Failed to resolve GitHub user profile by login; serving cached entry');
        return cached ? toAttributedUser(cached) : null;
    }
}
