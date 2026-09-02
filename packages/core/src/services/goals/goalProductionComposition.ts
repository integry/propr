import fs from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';
import { getAgentRegistry } from '../../agents/AgentRegistry.js';
import type { AgentConfig } from '../../agents/types.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../../auth/githubAuth.js';
import { loadMonitoredReposRaw } from '../../config/configManager.js';
import { createHooklessGit } from '../../git/hooklessGit.js';
import { ensureRepoCloned, getRepoUrl } from '../../git/repoManager.js';
import {
  addToSafeDirectories,
  getWorktreePath,
  setupWorktreePermissions,
} from '../../git/worktreeOperations.js';
import type { Goal } from './goalTypes.js';
import type {
  GoalArtifactVerifier,
  GoalProviderRuntime,
  GoalProviderRuntimeResolver,
  GoalWorkspaceIdentity,
  PersistedGoalReportedArtifact,
} from './goalRuntimeTypes.js';
import { GoalRepository } from './goalRepository.js';
import { GoalSupervisor } from './goalSupervisor.js';
import { GoalDockerContainerManager } from './goalDockerContainer.js';
import { CliGoalProviderRuntime } from './cliGoalProviderRuntime.js';
import { CodexGoalProviderRuntime } from './codexGoalProviderRuntime.js';

const SUPPORTED_PROVIDERS = new Set<AgentConfig['type']>(['claude', 'codex', 'antigravity']);

export class ProductionGoalRuntimeResolver implements GoalProviderRuntimeResolver {
  private readonly runtimes = new Map<string, GoalProviderRuntime>();

  constructor(
    private readonly containers = new GoalDockerContainerManager(),
    private readonly resolveToken = getGitHubInstallationToken
  ) {}

  resolve(agentAlias: string): GoalProviderRuntime {
    const existing = this.runtimes.get(agentAlias);
    if (existing) return existing;
    const agent = getAgentRegistry().getAgentByAlias(agentAlias);
    if (!agent || !agent.config.enabled || agent.config.goalCapable !== true) {
      throw new Error(`Goal agent '${agentAlias}' is not enabled and goal-capable`);
    }
    if (!SUPPORTED_PROVIDERS.has(agent.config.type)) {
      throw new Error(`Agent '${agentAlias}' has no native goal runtime`);
    }
    let runtime: GoalProviderRuntime;
    if (agent.config.type === 'codex') {
      runtime = new CodexGoalProviderRuntime(agent.config, this.containers, this.resolveToken);
    } else if (agent.config.type === 'claude' || agent.config.type === 'antigravity') {
      runtime = new CliGoalProviderRuntime(
        agent.config.type, agent.config, this.containers, this.resolveToken
      );
    } else {
      throw new Error(`Agent '${agentAlias}' has no native goal runtime`);
    }
    this.runtimes.set(agentAlias, runtime);
    return runtime;
  }
}

export class GitHubGoalArtifactVerifier implements GoalArtifactVerifier {
  async verifyFinalPullRequest(artifact: PersistedGoalReportedArtifact) {
    if (!/^\d+$/.test(artifact.externalRef)) throw new Error('Final artifact is not a pull request number');
    const [owner, repo, extra] = artifact.repository.split('/');
    if (!owner || !repo || extra) throw new Error('Final artifact repository is invalid');
    const octokit = await getAuthenticatedOctokit();
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: Number(artifact.externalRef),
    });
    const pull = response.data;
    if (pull.state !== 'open' || pull.draft !== true || pull.merged_at !== null) {
      throw new Error('Final epic PR must exist, remain draft, open, and unmerged');
    }
    if (pull.head.ref !== artifact.headBranch || pull.base.ref !== artifact.baseBranch) {
      throw new Error('GitHub final PR branches do not match the durable execution association');
    }
    if (artifact.headSha && pull.head.sha !== artifact.headSha) {
      throw new Error('GitHub final PR head SHA does not match the durable association');
    }
    if (!(pull.body ?? '').includes(artifact.marker)) {
      throw new Error('GitHub final PR is missing the durable goal association marker');
    }
    return {
      repository: artifact.repository,
      externalRef: artifact.externalRef,
      headBranch: pull.head.ref,
      baseBranch: pull.base.ref,
      headSha: pull.head.sha,
      state: 'open' as const,
      draft: true as const,
      merged: false as const,
      markerPresent: true as const,
    };
  }
}

export async function resolveGoalBaseBranch(goal: Goal): Promise<string> {
  const repository = (await loadMonitoredReposRaw()).find(item => item.name === goal.repository);
  return repository?.baseBranch ?? repository?.defaultBranch ?? 'main';
}

/** Initial allocation only. Recovery bypasses this function and uses the SQL snapshot. */
export async function allocateGoalWorkspace(
  goal: Goal,
  planned: GoalWorkspaceIdentity
): Promise<GoalWorkspaceIdentity> {
  const [owner, repo, extra] = goal.repository.split('/');
  if (!owner || !repo || extra) throw new Error('Goal repository must be owner/repository');
  const token = await getGitHubInstallationToken();
  const clonePath = await ensureRepoCloned({
    repoUrl: getRepoUrl({ repoOwner: owner, repoName: repo }),
    owner, repoName: repo, authToken: token, baseBranch: planned.baseBranch,
  });
  const worktreePath = getWorktreePath(owner, repo, planned.worktreeId);
  const git = createHooklessGit(clonePath);
  if (await persistedWorktreeMatches(worktreePath, planned.headBranch)) {
    return { ...planned, worktreePath };
  }
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git.raw([
    'fetch', 'origin',
    `+refs/heads/${planned.baseBranch}:refs/remotes/origin/${planned.baseBranch}`,
    '--prune',
  ]);
  await git.raw([
    'worktree', 'add', '--no-track', '-b', planned.headBranch,
    worktreePath, `origin/${planned.baseBranch}`,
  ]);
  await setupWorktreePermissions(worktreePath, planned.headBranch, goal.goalId);
  await addToSafeDirectories(git, worktreePath, clonePath, {
    branchName: planned.headBranch, issueId: goal.goalId,
  });
  return { ...planned, worktreePath };
}

export function createProductionGoalSupervisor(database: Knex): GoalSupervisor {
  return new GoalSupervisor(
    new GoalRepository(database),
    new ProductionGoalRuntimeResolver(),
    {
      resolveBaseBranch: resolveGoalBaseBranch,
      allocateWorkspace: allocateGoalWorkspace,
      artifactVerifier: new GitHubGoalArtifactVerifier(),
    }
  );
}

async function persistedWorktreeMatches(worktreePath: string, headBranch: string): Promise<boolean> {
  try {
    const git = createHooklessGit(worktreePath);
    return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() === headBranch;
  } catch {
    return false;
  }
}
