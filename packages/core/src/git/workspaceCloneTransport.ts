import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { AgentRunHandle, AgentRunMount, AgentRunResult, AgentRunSpec, AgentRunWorkspaceClone } from '../agents/runtime/types.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../auth/githubAuth.js';
import { getExecutionAbortError } from '../claude/docker/dockerExecutionOwnership.js';
import logger from '../utils/logger.js';
import { createHooklessGit } from './hooklessGit.js';
import { configureGitAuthentication } from './repoBranching.js';
import { redactAuthenticatedGitUrl } from './redactGitUrl.js';
import { assertGitHubRepositoryIdentity } from './repositoryPaths.js';
import { WorkspaceTransportError, type PreparedWorkspace, type WorkspaceRunOutcome, type WorkspaceTransport } from './workspaceTransport.js';
import {
    WORKSPACE_RESULT_BUNDLE_FILE, WORKSPACE_RESULT_BUNDLE_REF, WORKSPACE_RESULT_STATUS_FILE, WORKSPACE_TRANSPORT_ENVIRONMENT,
    WORKSPACE_TRANSPORT_RESULT_DIR, WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_TRANSPORT_TOKEN_ENV, cloneRunStartsAsRoot,
} from './workspaceTransportScript.js';

/** Namespace of the temporary refs a clone-mode run uses on the repository. */
export const WORKSPACE_RUN_REF_PREFIX = 'refs/propr/runs';

export interface GitHubRepository { owner: string; repo: string }

export interface CloneWorkspaceTransportDependencies {
    /** A short-lived installation token scoped to this one repository. */
    mintToken(repository: GitHubRepository, access: 'read' | 'write'): Promise<string>;
    revokeToken(token: string): Promise<void>;
    /** The worker's own token for publishing the base and fetching/deleting run refs; undefined for unauthenticated remotes. */
    workerToken(repository: GitHubRepository): Promise<string | undefined>;
    /** Credential-free URL both the worker and the sandbox use for the repository. */
    remoteUrl(repository: GitHubRepository): string;
    createRunId(spec: AgentRunSpec): string;
}

const GITHUB_API_URL = 'https://api.github.com';

async function mintRepositoryToken(repository: GitHubRepository, access: 'read' | 'write'): Promise<string> {
    const octokit = await getAuthenticatedOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner: repository.owner, repo: repository.repo });
    const auth = await octokit.auth({
        type: 'installation', refresh: true, repositoryIds: [data.id],
        permissions: { contents: access, metadata: 'read' },
    }) as { token: string; permissions?: Record<string, string>; repositorySelection?: string };
    const granted = auth.permissions ?? {};
    if (granted.contents !== access || Object.entries(granted).some(([key, value]) => !['contents', 'metadata'].includes(key) || (key === 'metadata' && value !== 'read'))) {
        throw new WorkspaceTransportError(`GitHub did not return a ${access} token scoped to ${repository.owner}/${repository.repo} contents; refusing to launch`);
    }
    return auth.token;
}

async function revokeInstallationToken(token: string): Promise<void> {
    const response = await fetch(`${GITHUB_API_URL}/installation/token`, {
        method: 'DELETE',
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'propr-workspace-transport' },
    });
    if (response.status !== 204 && response.status !== 401) throw new Error(`token revocation returned ${response.status}`);
}

export const defaultCloneWorkspaceTransportDependencies: CloneWorkspaceTransportDependencies = {
    mintToken: mintRepositoryToken,
    revokeToken: revokeInstallationToken,
    workerToken: () => getGitHubInstallationToken(),
    remoteUrl: ({ owner, repo }) => `https://github.com/${owner}/${repo}.git`,
    createRunId: spec => `${spec.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'run'}-${randomBytes(4).toString('hex')}`,
};

/** `owner/repo` of a GitHub remote URL (https or ssh, with or without credentials). */
export function parseGitHubRepository(url: string): GitHubRepository {
    const match = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    if (!match) throw new WorkspaceTransportError(`Clone workspace transport needs a GitHub origin; found ${redactAuthenticatedGitUrl(url) || 'none'}`);
    assertGitHubRepositoryIdentity(match[1], match[2]);
    return { owner: match[1], repo: match[2] };
}

function isWithin(target: string, root: string): boolean {
    const relative = path.posix.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

/** Mounts that exposed the worker worktree or its git metadata; a clone-mode run gets neither. */
function isWorkspaceMount(mount: AgentRunMount, containerPath: string): boolean {
    return mount.purpose === 'workspace' || mount.purpose === 'git' || isWithin(mount.target, containerPath);
}

/** In bind mode the agent owns git only when its git metadata is mounted writable (orchestrated goals). */
function agentOwnsCommits(spec: AgentRunSpec): boolean {
    return spec.mounts.some(mount => mount.type === 'bind' && mount.purpose === 'git' && !mount.readOnly);
}

async function rev(git: SimpleGit, ref: string): Promise<string> {
    return (await git.raw(['rev-parse', '--verify', '-q', ref])).trim();
}

interface CloneRun {
    worktree: string;
    repository: GitHubRepository;
    remote: string;
    runId: string;
    clone: AgentRunWorkspaceClone;
    localRef: string;
    ownsCommits: boolean;
    token?: string;
    bundlePath?: string;
    /**
     * Where the run's result stands once {@link CloneWorkspaceTransport.complete} started:
     * `pending` until the snapshot is verified in the worker's local ref, `retrieved`
     * while only that local ref holds it, `applied` once it is in the worktree.
     * Cleanup deletes only copies that are no longer the last recoverable one.
     */
    result?: 'pending' | 'retrieved' | 'applied';
    /** What the sandbox reported in its status file (`pushed`, `bundle`, `failed`), when it was readable. */
    reportedState?: string;
}

/**
 * Clone mode: the run clones the repository at the worker worktree's HEAD
 * (published to `refs/propr/runs/<runId>/base`) using a repository-scoped
 * token, and returns a snapshot commit on `refs/propr/runs/<runId>/result`
 * or, when it cannot push, as a bundle read through the runtime file API.
 * The worker applies the snapshot to its worktree as uncommitted changes (or,
 * when the agent owns git, moves the branch to the agent's commits), so the
 * normal commit/PR/review/follow-up flow continues unchanged.
 */
export class CloneWorkspaceTransport implements WorkspaceTransport {
    readonly mode = 'clone' as const;

    constructor(private readonly deps: CloneWorkspaceTransportDependencies = defaultCloneWorkspaceTransportDependencies) {}

    private async workerGit(run: Pick<CloneRun, 'worktree' | 'repository'>): Promise<SimpleGit> {
        const git = createHooklessGit(run.worktree);
        const token = await this.deps.workerToken(run.repository);
        if (token) configureGitAuthentication(git, token);
        return git;
    }

    async prepare(spec: AgentRunSpec): Promise<PreparedWorkspace> {
        // A read-only workspace is a kernel read-only mount in bind mode. A sandbox checkout
        // cannot give the same guarantee: file modes do not stop an agent that runs as root
        // (Vibe's read-only analysis config does), and an agent-owned parent directory lets the
        // agent move the checkout away and put altered content in its place. Refuse before
        // anything is published or a token is minted.
        if (spec.workspace.readOnly) {
            throw new WorkspaceTransportError(`Clone workspace transport cannot enforce a read-only workspace for ${spec.name}; run it with the bind transport`);
        }
        // The token's only boundary inside the run is the user ID: a process under the
        // wrapper's identity can read its initial environment (`/proc/<pid>/environ`) and
        // memory. The wrapper must start as root so the setup hook, agent and snapshot run as
        // the separate unprivileged agent user. Refuse before a token exists.
        if (!cloneRunStartsAsRoot(spec.user)) {
            throw new WorkspaceTransportError(`Clone workspace transport needs ${spec.name} to start as root so its credential-holding wrapper runs under a different user ID from the setup hook and agent; it starts as ${spec.user ? `"${spec.user}"` : 'the image user'}`);
        }
        const worktree = spec.workspace.hostPath;
        const local = createHooklessGit(worktree);
        let baseCommit: string;
        try {
            baseCommit = await rev(local, 'HEAD');
        } catch (cause) {
            throw new WorkspaceTransportError(`Clone workspace transport needs a git worktree with a commit at ${worktree}`, { cause });
        }
        const dirty = (await local.raw(['status', '--porcelain', '--untracked-files=all'])).trim();
        if (dirty) throw new WorkspaceTransportError(`Clone workspace transport needs a clean worktree; ${worktree} has uncommitted changes`);
        const repository = parseGitHubRepository((await local.raw(['config', '--get', 'remote.origin.url']).catch(() => '')).trim());
        const runId = this.deps.createRunId(spec);
        const branch = (await local.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || `propr/run-${runId}`;
        const prefix = `${WORKSPACE_RUN_REF_PREFIX}/${runId}`;
        const remote = this.deps.remoteUrl(repository);
        const run: CloneRun = {
            worktree, repository, remote, runId, localRef: prefix, ownsCommits: agentOwnsCommits(spec),
            clone: {
                remote, baseRef: `${prefix}/base`, baseCommit, branch, resultRef: `${prefix}/result`,
                resultDir: WORKSPACE_TRANSPORT_RESULT_DIR, script: WORKSPACE_TRANSPORT_SCRIPT,
            },
        };
        try {
            await (await this.workerGit(run)).raw(['push', '--no-verify', '--quiet', remote, `${baseCommit}:${run.clone.baseRef}`]);
            run.token = await this.deps.mintToken(repository, 'write');
        } catch (error) {
            await this.cleanup(run);
            if (error instanceof WorkspaceTransportError) throw error;
            throw new WorkspaceTransportError(`Could not publish the task base for ${repository.owner}/${repository.repo}: ${redactAuthenticatedGitUrl((error as Error).message)}`, { cause: error });
        }
        logger.info({ run: spec.name, runId, repository: `${repository.owner}/${repository.repo}`, baseCommit }, 'Prepared clone-mode workspace');
        return {
            spec: this.cloneSpec(spec, run.clone),
            launchEnvironment: { [WORKSPACE_TRANSPORT_TOKEN_ENV]: run.token! },
            complete: (handle, result, options) => this.complete(run, handle, result, options?.signal),
            cleanup: handle => this.cleanup(run, handle),
        };
    }

    private cloneSpec(spec: AgentRunSpec, clone: AgentRunWorkspaceClone): AgentRunSpec {
        const { containerPath } = spec.workspace;
        let order = Math.max(-1, ...spec.mounts.map(m => m.order), ...spec.env.map(v => v.order), ...spec.envFiles.map(f => f.order)) + 1;
        const E = WORKSPACE_TRANSPORT_ENVIRONMENT;
        const variables: Array<[string, string | undefined]> = [
            [E.path, containerPath], [E.remote, clone.remote], [E.baseRef, clone.baseRef], [E.baseCommit, clone.baseCommit],
            [E.branch, clone.branch], [E.resultRef, clone.resultRef ?? ''], [E.resultDir, clone.resultDir],
            // Name only: the value travels in the launch environment, never in the spec or argv.
            [WORKSPACE_TRANSPORT_TOKEN_ENV, undefined],
        ];
        return {
            ...spec,
            workspace: { ...spec.workspace, mode: 'clone', clone },
            mounts: spec.mounts.filter(mount => !isWorkspaceMount(mount, containerPath)),
            env: [...spec.env, ...variables.map(([name, value]) => ({ name, ...(value === undefined ? {} : { value }), order: order++ }))],
        };
    }

    private async readResultFile(handle: AgentRunHandle, name: string): Promise<Buffer | null> {
        if (!handle.readFile) return null;
        try {
            return await handle.readFile(path.posix.join(WORKSPACE_TRANSPORT_RESULT_DIR, name));
        } catch (error) {
            logger.warn({ run: handle.spec.name, file: name, error: (error as Error).message }, 'Could not read a workspace result file from the run');
            return null;
        }
    }

    private async complete(run: CloneRun, handle: AgentRunHandle, result: AgentRunResult, signal?: AbortSignal): Promise<WorkspaceRunOutcome> {
        // Cancelled before anything was returned: like a run aborted while it ran, nothing is retrieved or kept.
        const aborted = getExecutionAbortError(signal);
        if (aborted) throw aborted;
        run.result = 'pending';
        try {
            const outcome = await this.retrieveAndApply(run, handle, result, signal);
            run.result = 'applied';
            return outcome;
        } catch (error) {
            const kept = this.preservedLocations(run, handle);
            const recovery = kept.length ? `the run's result is kept for recovery at ${kept.join(' and ')}` : 'no recoverable copy of the run\'s result remains';
            throw new WorkspaceTransportError(`${(error as Error).message}; ${recovery}`, { cause: error });
        }
    }

    /** Where an unapplied result stays: the worker's local ref once retrieved, otherwise the run's result ref and the kept run. */
    private preservedLocations(run: CloneRun, handle?: AgentRunHandle): string[] {
        if (run.result === 'retrieved') return [`${run.localRef} in ${run.worktree}`];
        // A sandbox that reported a bundle or a failure pushed no result ref.
        const pushed = run.reportedState !== 'bundle' && run.reportedState !== 'failed';
        return [...(pushed ? [`${run.clone.resultRef} on ${run.remote}`] : []), ...(handle?.release ? [`the kept run ${handle.spec.name}`] : [])];
    }

    private async retrieveAndApply(run: CloneRun, handle: AgentRunHandle, result: AgentRunResult, signal?: AbortSignal): Promise<WorkspaceRunOutcome> {
        const status = (await this.readResultFile(handle, WORKSPACE_RESULT_STATUS_FILE))?.toString('utf8').trim();
        const [state, commit] = status?.split(/\s+/) ?? [];
        run.reportedState = state;
        // A run that left a bundle (or whose status is unknown) may hold the only copy of its
        // result: cancel the runtime's automatic removal before retrieving it, so neither a slow
        // retrieval nor a failed one loses it. Cleanup releases it explicitly once the worker
        // holds the result. A pushed result's copy is the result ref; a failed run has none.
        if (state !== 'pushed' && state !== 'failed') handle.retain?.();
        if (state === 'failed') throw new WorkspaceTransportError(`The run could not return its workspace (${status}; exit ${result.exitCode})`);
        const git = await this.workerGit(run);
        let via: WorkspaceRunOutcome['via'];
        if (state !== 'bundle') {
            try {
                await git.raw(['fetch', '--no-tags', '--quiet', run.remote, `+${run.clone.resultRef}:${run.localRef}`]);
                via = 'ref';
            } catch (error) {
                logger.warn({ run: handle.spec.name, error: redactAuthenticatedGitUrl((error as Error).message) }, 'Run result ref not fetched; trying the bundle fallback');
            }
        }
        if (!via && await this.fetchBundle(run, handle, git)) via = 'bundle';
        if (!via) throw new WorkspaceTransportError(`The run returned no workspace result (exit ${result.exitCode})`);
        const snapshot = await rev(git, run.localRef);
        if (commit && snapshot !== commit) throw new WorkspaceTransportError(`Run result ${snapshot} does not match the reported snapshot ${commit}`);
        // The verified snapshot is now on the worker: the sandbox copies are no longer the only ones.
        run.result = 'retrieved';
        await this.apply(run, git, snapshot, signal);
        return { applied: true, via, commit: snapshot };
    }

    private async fetchBundle(run: CloneRun, handle: AgentRunHandle, git: SimpleGit): Promise<boolean> {
        const bundle = await this.readResultFile(handle, WORKSPACE_RESULT_BUNDLE_FILE);
        if (!bundle) return false;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-run-bundle-'));
        run.bundlePath = path.join(directory, WORKSPACE_RESULT_BUNDLE_FILE);
        await fs.writeFile(run.bundlePath, bundle, { mode: 0o600 });
        await git.raw(['bundle', 'verify', '--quiet', run.bundlePath]);
        await git.raw(['fetch', '--no-tags', '--quiet', run.bundlePath, `+${WORKSPACE_RESULT_BUNDLE_REF}:${run.localRef}`]);
        return true;
    }

    /** Lay the snapshot over the worktree: working tree = snapshot, index and branch = worker HEAD (or the agent's own commits). */
    private async apply(run: CloneRun, git: SimpleGit, snapshot: string, signal?: AbortSignal): Promise<void> {
        const head = await rev(git, 'HEAD');
        if (head !== run.clone.baseCommit) {
            throw new WorkspaceTransportError(`Worktree ${run.worktree} moved from ${run.clone.baseCommit} to ${head} during the run; not applying its result`);
        }
        const agentHead = await rev(git, `${snapshot}^`);
        // Last point before the worktree changes: a run cancelled during retrieval applies
        // nothing, and its retrieved snapshot stays on the local ref for recovery. Once the
        // first git command below starts, the result is applied whatever happens next.
        const aborted = getExecutionAbortError(signal);
        if (aborted) throw new WorkspaceTransportError(`${aborted.message}; not applying the run's result`, { cause: aborted });
        if (run.ownsCommits && agentHead !== head) await git.raw(['reset', '--quiet', '--hard', agentHead]);
        await git.raw(['read-tree', '--reset', '-u', snapshot]);
        await git.raw(['reset', '--quiet']);
    }

    private async cleanup(run: CloneRun, handle?: AgentRunHandle): Promise<void> {
        const failures: string[] = [];
        const attempt = async (step: string, action: () => Promise<unknown>) => {
            try { await action(); } catch (error) { failures.push(`${step}: ${redactAuthenticatedGitUrl((error as Error).message)}`); }
        };
        // Credentials go whatever happened to the result.
        if (run.token) await attempt('revoke token', () => this.deps.revokeToken(run.token!));
        run.token = undefined;
        // A result that was returned but never applied keeps its last recoverable copy:
        // the worker's local ref once retrieved, otherwise the run's result ref and kept run.
        const keepSandboxResult = run.result === 'pending';
        const keepLocalResult = run.result === 'retrieved';
        if (handle?.release && !keepSandboxResult) await attempt('release run', () => handle.release!());
        const git = createHooklessGit(run.worktree);
        if (!keepLocalResult) await attempt('local ref', () => git.raw(['update-ref', '-d', run.localRef]).catch(() => undefined));
        // Unless the listing shows otherwise, an undeleted result ref may still be there.
        let keptRemoteResult = keepSandboxResult;
        await attempt('remote refs', async () => {
            const authenticated = await this.workerGit(run);
            const listed = await authenticated.raw(['ls-remote', run.remote, `${run.localRef}/*`]);
            const listedRefs = listed.split('\n').map(line => line.split('\t')[1]?.trim()).filter((ref): ref is string => !!ref);
            keptRemoteResult = keepSandboxResult && listedRefs.includes(run.clone.resultRef!);
            const refs = keptRemoteResult ? listedRefs.filter(ref => ref !== run.clone.resultRef) : listedRefs;
            if (refs.length) await authenticated.raw(['push', '--no-verify', '--quiet', run.remote, ...refs.map(ref => `:${ref}`)]);
        });
        if (run.bundlePath) await attempt('bundle', () => fs.rm(path.dirname(run.bundlePath!), { recursive: true, force: true }));
        if (keepSandboxResult || keepLocalResult) {
            const kept = keepLocalResult ? this.preservedLocations(run, handle)
                : [...(keptRemoteResult ? [`${run.clone.resultRef} on ${run.remote}`] : []), ...(handle?.release ? [`the kept run ${handle.spec.name}`] : [])];
            logger.warn({ runId: run.runId, kept }, kept.length
                ? 'Run result was not applied; kept its recoverable copies'
                : 'Run result was not applied and no recoverable copy of it was found');
        }
        if (failures.length) throw new WorkspaceTransportError(`Clone workspace cleanup for ${run.runId} incomplete: ${failures.join('; ')}`);
    }
}
