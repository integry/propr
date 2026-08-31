import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { GoalRepositoryIdentity } from './contract.js';

const SAFE_REMOTE_PROTOCOLS = new Set(['git:', 'http:', 'https:', 'ssh:']);
const SAFE_HOST = /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]*[a-z\d])?))+$/i;
const SAFE_PATH_SEGMENT = /^[a-z\d._~-]+$/i;
const SAFE_BRANCH = /^(?![./])(?!.*(?:\.\.|@\{|\\|\s|[~^:?*]|\[))(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SAFE_SHA = /^[a-f\d]{4,64}$/i;
const SENSITIVE_WORKTREE_ROOTS = ['/', '/etc', '/root', '/home', '/proc', '/sys', '/dev'];
const SECRET_LIKE = /(?:gh[oprsu]_|github_pat_|sk-|AKIA|bearer[._-]?[A-Za-z0-9]|(?:secret|token|password)[._:-][A-Za-z0-9_-]{6,})/i;

function normalizedRemoteHost(host: string): string | undefined {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return SAFE_HOST.test(normalized) ? normalized : undefined;
}

function normalizedHostPath(host: string, repositoryPath: string): string | undefined {
    const normalizedHost = normalizedRemoteHost(host);
    const cleaned = cleanPath(repositoryPath);
    if (!normalizedHost || !cleaned) return undefined;
    return (normalizedHost === 'github.com' ? cleaned : `${normalizedHost}/${cleaned}`).toLowerCase();
}

function cleanPath(value: string): string | undefined {
    const withoutSuffix = value.split(/[?#]/, 1)[0];
    const segments = withoutSuffix.replace(/^\/+|\/+$/g, '').split('/');
    if (segments.length < 2 || segments.some(segment =>
        !segment || segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment))) return undefined;
    segments[segments.length - 1] = segments.at(-1)!.replace(/\.git$/i, '');
    if (!segments.at(-1)) return undefined;
    return segments.join('/');
}

/**
 * Converts a Git remote or logical repository name to the credential-free
 * identity used for fencing. Userinfo, query strings, and fragments are never
 * returned. Undefined means no trustworthy host/path identity was available.
 */
export function normalizeGitRepositoryIdentity(value: string): string | undefined {
    const trimmed = value.trim().replace(/^git\+/, '');
    if (!trimmed || [...trimmed].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    })) return undefined;
    if (trimmed.includes('://')) {
        try {
            const remote = new URL(trimmed);
            if (!SAFE_REMOTE_PROTOCOLS.has(remote.protocol)) return undefined;
            const credentialFreeSshUser = remote.protocol === 'ssh:'
                && remote.username.toLowerCase() === 'git' && !remote.password;
            if ((remote.username && !credentialFreeSshUser) || remote.password || remote.search || remote.hash) return undefined;
            return normalizedHostPath(remote.hostname, remote.pathname);
        } catch {
            return undefined;
        }
    }
    const scp = /^(?:(.+)@)?([^/:\s]+):\/?(.+)$/.exec(trimmed);
    if (scp) {
        if (scp[1] && scp[1].toLowerCase() !== 'git') return undefined;
        return normalizedHostPath(scp[2], scp[3]);
    }
    if (trimmed.includes('@') || trimmed.includes(':') || trimmed.includes('\\')) return undefined;
    const logical = cleanPath(trimmed);
    return logical?.toLowerCase();
}

export function normalizeGoalRepositoryIdentity(
    repository: GoalRepositoryIdentity,
): GoalRepositoryIdentity | undefined {
    const normalized = normalizeGitRepositoryIdentity(repository.repository);
    const worktreePath = path.resolve(repository.worktreePath);
    const branch = repository.branch.trim();
    if (!normalized || SECRET_LIKE.test(normalized) || repository.worktreePath !== worktreePath
        || isSensitiveWorktreePath(worktreePath) || SECRET_LIKE.test(worktreePath)
        || !SAFE_BRANCH.test(branch) || SECRET_LIKE.test(branch)) return undefined;
    return {
        repository: normalized,
        worktreePath,
        branch,
        headSha: SAFE_SHA.test(repository.headSha ?? '') ? repository.headSha!.toLowerCase() : undefined,
    };
}

/** Canonical ingress validator shared by turns, durable recovery, and Git inspection. */
export async function normalizeCanonicalGoalRepositoryIdentity(
    repository: GoalRepositoryIdentity,
): Promise<GoalRepositoryIdentity | undefined> {
    const normalized = normalizeGoalRepositoryIdentity(repository);
    if (!normalized) return undefined;
    const resolved = await realpath(normalized.worktreePath).catch(() => normalized.worktreePath);
    if (resolved !== normalized.worktreePath || isSensitiveWorktreePath(resolved)) return undefined;
    return normalized;
}

export function isSensitiveWorktreePath(value: string): boolean {
    const candidate = path.resolve(value);
    return SENSITIVE_WORKTREE_ROOTS.some(root => candidate === root || (root !== '/' && candidate.startsWith(`${root}/`)));
}

/** Stable logical checkout identity. Mutable HEAD/checkpoint state is deliberately excluded. */
export function fingerprintGoalWorktree(repository: GoalRepositoryIdentity): string {
    const repositoryName = normalizeGitRepositoryIdentity(repository.repository);
    if (!repositoryName) throw new Error('Repository identity is not a trustworthy Git repository name or remote');
    return createHash('sha256').update([
        repositoryName,
        path.resolve(repository.worktreePath),
        repository.branch,
    ].join('\0')).digest('hex');
}
