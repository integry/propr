import { createHash } from 'node:crypto';
import path from 'node:path';
import type { GoalRepositoryIdentity } from './contract.js';

const SAFE_REMOTE_PROTOCOLS = new Set(['git:', 'http:', 'https:', 'ssh:']);
const SAFE_HOST = /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]*[a-z\d])?))+$/i;
const SAFE_PATH_SEGMENT = /^[a-z\d._~-]+$/i;

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
            return normalizedHostPath(remote.hostname, remote.pathname);
        } catch {
            return undefined;
        }
    }
    const scp = /^(?:.+@)?([^/:\s]+):\/?(.+)$/.exec(trimmed);
    if (scp) return normalizedHostPath(scp[1], scp[2]);
    if (trimmed.includes('@') || trimmed.includes(':') || trimmed.includes('\\')) return undefined;
    const logical = cleanPath(trimmed);
    return logical?.toLowerCase();
}

export function normalizeGoalRepositoryIdentity(
    repository: GoalRepositoryIdentity,
): GoalRepositoryIdentity | undefined {
    const normalized = normalizeGitRepositoryIdentity(repository.repository);
    if (!normalized) return undefined;
    return {
        repository: normalized,
        worktreePath: repository.worktreePath,
        branch: repository.branch,
        headSha: repository.headSha,
    };
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
