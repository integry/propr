import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getAuthenticatedOctokit, type PaginatedOctokitInstance } from '../auth/githubAuth.js';
import { loadMonitoredReposStrict } from '../config/configManager.js';
import { assertGitHubRepositoryIdentity } from '../git/repositoryPaths.js';
import type { AgentTaskOptions, AnalyzeOptions } from './types.js';

export const AGENT_READ_PERMISSIONS = {
    contents: 'read', issues: 'read', pull_requests: 'read', metadata: 'read',
} as const;
const OPTIONAL_AGENT_READ_PERMISSIONS = ['checks', 'actions', 'statuses'] as const;

export function resolveContextRepositories(repository: string, setting: unknown): string[] | undefined {
    if (setting === undefined || setting === 'all') return undefined;
    if (setting !== 'none' && !Array.isArray(setting)) throw new Error('Context repositories must be all, none, or a list of owner/repository names');
    const repositories = [repository, ...(setting === 'none' ? [] : setting)];
    for (const name of repositories) {
        if (typeof name !== 'string' || name.split('/').length !== 2) throw new Error('Invalid context repository');
        const [owner, repo] = name.split('/');
        assertGitHubRepositoryIdentity(owner, repo);
    }
    return [...new Set(repositories.map(name => name.toLowerCase()))].sort();
}

export function agentOwnsGit(options: Pick<AgentTaskOptions, 'executionMode' | 'environment'>): boolean {
    return options.executionMode === 'goal' && options.environment?.PROPR_GOAL_LAUNCH_STRATEGY === 'orchestrate';
}

export function buildAgentGitCredentialArgs(): string[] {
    return ['-e', 'GIT_OPTIONAL_LOCKS=0', '-e', 'GIT_CONFIG_COUNT=2', '-e', 'GIT_CONFIG_KEY_0=credential.helper',
        '-e', 'GIT_CONFIG_VALUE_0=', '-e', 'GIT_CONFIG_KEY_1=credential.https://github.com.helper',
        '-e', 'GIT_CONFIG_VALUE_1=!gh auth git-credential'];
}

export function buildAgentGitMountArgs(worktreePath: string, writable = false, readOnlyWorkspace = false): string[] {
    return [
        ...(!writable && !readOnlyWorkspace ? ['-v', `${path.join(worktreePath, '.git')}:/home/node/workspace/.git:ro`] : []),
        '-v', `/tmp/git-processor:/tmp/git-processor:${writable ? 'rw' : 'ro'}`,
    ];
}

/** Remove credentials left in clone configs by older workers before exposing them. */
async function scrubLegacyCloneCredentials(clonePath: string): Promise<void> {
    const configPath = path.join(clonePath, '.git', 'config');
    let config: string;
    try { config = await fs.readFile(configPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const clean = config.replace(/https:\/\/[^\s/@]+:[^\s/@]+@github\.com\//g, 'https://github.com/');
    if (clean !== config) {
        // Wait briefly for concurrent git writers, but never remove their lock.
        // Read again under our own lock so their completed edits are preserved.
        const lockPath = `${configPath}.lock`;
        const lock = await acquireConfigLock(lockPath);
        let published = false;
        try {
            const current = await fs.readFile(configPath, 'utf8');
            await lock.writeFile(current.replace(/https:\/\/[^\s/@]+:[^\s/@]+@github\.com\//g, 'https://github.com/'));
            await lock.chmod(0o644);
            await lock.close();
            await fs.rename(lockPath, configPath);
            published = true;
        } finally {
            await lock.close();
            if (!published) await fs.rm(lockPath, { force: true });
        }
    }
}

async function acquireConfigLock(lockPath: string): Promise<fs.FileHandle> {
    for (let attempt = 0; ; attempt++) {
        try { return await fs.open(lockPath, 'wx', 0o600); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 10) throw error;
            await delay(50);
        }
    }
}

async function visibleClonePaths(root: string, repositories?: string[]): Promise<string[]> {
    let owners;
    try { owners = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const paths: string[] = [];
    for (const owner of owners.filter(entry => entry.isDirectory())) {
        for (const repo of await fs.readdir(path.join(root, owner.name), { withFileTypes: true })) {
            if (repo.isDirectory() && (!repositories || repositories.includes(`${owner.name}/${repo.name}`.toLowerCase()))) paths.push(path.join(root, owner.name, repo.name));
        }
    }
    return paths;
}

/** The same scoped mint path is used by all adapters and the live boundary test. */
export async function mintAgentGitHubToken(octokit: PaginatedOctokitInstance, writable = false, repositoryIds?: number[]): Promise<string> {
    // The unscoped worker token reports the installation's actual grants in both
    // own-App and relay mode. It is never passed to a read-only container.
    const granted = !writable ? (await octokit.auth({ type: 'installation' }) as { permissions?: Record<string, string> }).permissions : undefined;
    let requested = { ...AGENT_READ_PERMISSIONS, ...Object.fromEntries(
        OPTIONAL_AGENT_READ_PERMISSIONS.filter(key => ['read', 'write'].includes(granted?.[key] ?? '')).map(key => [key, 'read'])
    ) };
    const mint = () => octokit.auth({
        type: 'installation', refresh: true,
        ...(!writable ? { permissions: requested } : {}),
        ...(repositoryIds ? { repositoryIds } : {}),
    }) as Promise<{ token: string; permissions?: Record<string, string> }>;
    let auth;
    try {
        auth = await mint();
    } catch (error) {
        // Grants may change after discovery (or while the worker token is cached).
        // Retry without optional reads only; never relax repository or required scope.
        if (writable || (error as { status?: number }).status !== 422
            || Object.keys(requested).length === Object.keys(AGENT_READ_PERMISSIONS).length) throw error;
        requested = { ...AGENT_READ_PERMISSIONS };
        auth = await mint();
    }
    if (!writable && (!auth.permissions || Object.keys(AGENT_READ_PERMISSIONS).some(key => auth.permissions![key] !== 'read') || Object.entries(auth.permissions).some(([key, value]) =>
        !(key in requested) || value !== 'read'))) {
        throw new Error('GitHub auth did not return a read-only agent token; refusing to launch');
    }
    return auth.token;
}

/** Fork PR worktrees can link to a clone different from their issue repository. */
async function taskGitMetadataMount(worktreePath: string, clones: string[], writable: boolean): Promise<string[]> {
    let pointer: string;
    try { pointer = await fs.readFile(path.join(worktreePath, '.git'), 'utf8'); }
    catch (error) {
        if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code || '')) return [];
        throw error;
    }
    const match = /^gitdir: (.+)\s*$/.exec(pointer.trim());
    if (!match) throw new Error('Invalid task worktree git metadata pointer');
    const gitdir = path.resolve(worktreePath, match[1]);
    const common = path.dirname(path.dirname(gitdir));
    const root = path.resolve(process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones');
    if (!common.startsWith(`${root}/`) || path.basename(common) !== '.git'
        || path.basename(path.dirname(gitdir)) !== 'worktrees') {
        throw new Error('Task git metadata is outside the managed clone directory');
    }
    if (clones.some(clone => common === path.join(clone, '.git'))) return [];
    // Only the task's git data, not an unlisted repository's working copy.
    await scrubLegacyCloneCredentials(path.dirname(common));
    return ['-v', `${common}:${common}:${writable ? 'rw' : 'ro'}`];
}

/** Called at the adapter boundary, including follow-ups, fixes and native goal resumes. */
export async function prepareAgentGitAccess(options: AgentTaskOptions, readOnlyWorkspace = false): Promise<AgentTaskOptions> {
    // No token is minted and no clone is mounted, whatever the repository settings.
    if (options.repositoryAccess === 'none') return { ...options, githubToken: '', gitMountArgs: [] };
    const writable = agentOwnsGit(options);
    const repository = `${options.issueRef.repoOwner}/${options.issueRef.repoName}`;
    const entries = (await loadMonitoredReposStrict()).filter(repo => repo.name.toLowerCase() === repository.toLowerCase());
    // Conflicting branch entries must never silently broaden the policy.
    const policies = entries.map(entry => resolveContextRepositories(repository, entry.contextRepositories)).filter(value => value !== undefined);
    const repositories = policies.length ? policies.reduce((a, b) => a.filter(name => b.includes(name))) : undefined;
    const octokit = await getAuthenticatedOctokit();
    const repositoryIds = repositories ? [...new Set(await Promise.all(repositories.map(async name => {
        const [owner, repo] = name.split('/');
        try {
            return (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.id;
        } catch (cause) {
            throw new Error(`Cannot resolve contextRepositories entry "${name}" for ${repository}. Correct or remove the entry in repository settings, and ensure the App installation can access it.`, { cause });
        }
    })))] : undefined;
    let token: string;
    try {
        token = await mintAgentGitHubToken(octokit, writable, repositoryIds);
    } catch (cause) {
        if (!repositories) throw cause;
        throw new Error(`Cannot mint agent token for ${repository} with contextRepositories: ${repositories.join(', ')}. Ensure every repository is included in the App installation and required read permissions are granted, or correct repository settings.`, { cause });
    }
    const root = path.resolve(process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones');
    // The blanket mount also exposes clones retained at the default location
    // after GIT_CLONES_BASE_PATH changes. Scrub every exposed root before launch.
    const roots = repositories ? [root] : [...new Set([root, '/tmp/git-processor/clones'])];
    const clones = (await Promise.all(roots.map(root => visibleClonePaths(root, repositories)))).flat();
    for (const clone of clones) await scrubLegacyCloneCredentials(clone);
    const taskMetadata = repositories ? await taskGitMetadataMount(options.worktreePath, clones, writable) : [];
    const gitMountArgs = repositories ? [
        ...taskMetadata,
        ...(!writable && !readOnlyWorkspace ? ['-v', `${path.join(options.worktreePath, '.git')}:/home/node/workspace/.git:ro`] : []),
        ...(await Promise.all(clones.map(async clone => {
            try { await fs.access(clone); return ['-v', `${clone}:${clone}:${writable ? 'rw' : 'ro'}`]; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        }))).flat(),
    ] : [
        ...buildAgentGitMountArgs(options.worktreePath, writable, readOnlyWorkspace),
        ...clones.filter(clone => !clone.startsWith('/tmp/git-processor/')).flatMap(clone => ['-v', `${clone}:${clone}:${writable ? 'rw' : 'ro'}`]),
    ];
    return { ...options, githubToken: token, gitMountArgs };
}

/** Repository inspection stays credential-free; context-free analysis has no repository access. */
export async function prepareAnalysisGitAccess(options: AnalyzeOptions | undefined, worktreePath: string): Promise<{ githubToken: string; gitMountArgs: string[] }> {
    if (!options?.repository || (options.readOnlyWorkspacePath && options.allowReadOnlyCommands)) {
        return { githubToken: '', gitMountArgs: [] };
    }
    resolveContextRepositories(options.repository, 'none'); // Validate before interpreting the identity.
    const [repoOwner, repoName] = options.repository.split('/');
    const prepared = await prepareAgentGitAccess({
        worktreePath, prompt: '', githubToken: '', issueRef: { repoOwner, repoName, number: options.taskNumber ?? 0 },
    }, true);
    return { githubToken: prepared.githubToken, gitMountArgs: prepared.gitMountArgs! };
}
