import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { GoalController, type GoalControllerOptions } from './goalController.js';
import { GoalControllerSupervisor, type GoalSupervisorOptions } from './goalControllerSupervisor.js';
import { buildGoalArtifactMarker, GoalOrchestrationRepository } from './goalOrchestrationRepository.js';
import { GoalRepository } from './goalRepository.js';
import type {
  GoalArtifactMarker,
  GoalEventPort,
  GoalGitHubPort,
  GoalGitHubRemoteArtifact,
  GoalOutboxOperation,
  GoalReadinessPolicy,
  GoalRuntimePort,
  GoalValidationEvidenceInput,
  GoalValidationPort,
  GoalValidationRequest,
} from './goalOrchestrationTypes.js';

interface OctokitLike {
  request<T = unknown>(route: string, options: Record<string, unknown>): Promise<{ data: T }>;
  paginate<T = unknown>(route: string, options: Record<string, unknown>): Promise<T[]>;
}

interface IssueData {
  id: number; number: number; html_url: string; body: string | null; state: string;
  labels?: Array<string | { name?: string }>;
}

interface PullData extends IssueData {
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged_at: string | null;
}

interface CommentData { id: number; html_url: string; body: string | null }

function repositoryParts(repository: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, repo };
}

function labelsOf(item: IssueData): string[] {
  return (item.labels ?? []).map((label) => typeof label === 'string' ? label : label.name ?? '').filter(Boolean).sort();
}

/** GitHub adapter used by the worker process; every mutation comes from the SQL outbox. */
export class ProPRGoalGitHubPort implements GoalGitHubPort {
  constructor(private readonly octokit: OctokitLike) {}

  async findByMarker(marker: GoalArtifactMarker): Promise<GoalGitHubRemoteArtifact | null> {
    const { owner, repo } = repositoryParts(marker.repository);
    const encoded = buildGoalArtifactMarker(marker);
    if (marker.artifactKind === 'branch') {
      try {
        const response = await this.octokit.request<{ object: { sha: string } }>('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner, repo, ref: `heads/${marker.head}`,
        });
        return {
          remoteId: `refs/heads/${marker.head}`, repository: marker.repository, kind: 'branch', marker: encoded,
          headBranch: marker.head, baseBranch: marker.base, headSha: response.data.object.sha, state: 'present',
        };
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    }
    if (marker.artifactKind === 'pull_request') {
      const pulls = await this.octokit.paginate<PullData>('GET /repos/{owner}/{repo}/pulls', {
        owner, repo, state: 'all', head: marker.head, base: marker.base, per_page: 100,
      });
      const pull = pulls.find((candidate) => candidate.body?.includes(encoded));
      return pull ? this.pullArtifact(marker, pull) : null;
    }
    if (marker.artifactKind === 'comment') {
      const search = await this.octokit.request<{ items: IssueData[] }>('GET /search/issues', {
        q: `repo:${owner}/${repo} in:comments "${encoded}"`, per_page: 100,
      });
      for (const issue of search.data.items) {
        const comments = await this.octokit.paginate<CommentData>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          owner, repo, issue_number: issue.number, per_page: 100,
        });
        const comment = comments.find((candidate) => candidate.body?.includes(encoded));
        if (comment) return {
          remoteId: String(comment.id), number: issue.number, url: comment.html_url,
          repository: marker.repository, kind: 'comment', marker: encoded,
          headBranch: marker.head, baseBranch: marker.base, state: 'present', body: comment.body,
        };
      }
      return null;
    }
    if (marker.artifactKind === 'label' && marker.head) {
      try {
        await this.octokit.request('GET /repos/{owner}/{repo}/labels/{name}', { owner, repo, name: marker.head });
        return {
          remoteId: marker.head, repository: marker.repository, kind: 'label', marker: encoded,
          headBranch: marker.head, baseBranch: marker.base, state: 'present',
        };
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    }
    const issues = await this.octokit.paginate<IssueData>('GET /repos/{owner}/{repo}/issues', {
      owner, repo, state: 'all', per_page: 100,
    });
    const issue = issues.find((candidate) => candidate.body?.includes(encoded));
    if (!issue) return null;
    return {
      remoteId: String(issue.id), number: issue.number, url: issue.html_url,
      repository: marker.repository, kind: marker.artifactKind, marker: encoded,
      headBranch: marker.head, baseBranch: marker.base,
      state: issue.state === 'open' ? 'present' : 'closed', labels: labelsOf(issue), body: issue.body,
    };
  }

  async execute(operation: GoalOutboxOperation, marker: GoalArtifactMarker): Promise<GoalGitHubRemoteArtifact | null> {
    const { owner, repo } = repositoryParts(marker.repository);
    const payload = operation.payload;
    if (operation.operationKind === 'create_branch') {
      const base = await this.octokit.request<{ object: { sha: string } }>('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner, repo, ref: `heads/${String(payload.base)}`,
      });
      await this.octokit.request('POST /repos/{owner}/{repo}/git/refs', {
        owner, repo, ref: `refs/heads/${String(payload.head)}`, sha: base.data.object.sha,
      });
      return this.findByMarker(marker);
    }
    if (operation.operationKind === 'create_issue') {
      const response = await this.octokit.request<IssueData>('POST /repos/{owner}/{repo}/issues', {
        owner, repo, title: payload.title,
        body: this.issueBody(payload, operation.marker), labels: payload.labels,
      });
      return this.issueArtifact(marker, response.data);
    }
    if (operation.operationKind === 'create_pull_request') {
      const response = await this.octokit.request<PullData>('POST /repos/{owner}/{repo}/pulls', {
        owner, repo, title: payload.title, head: payload.head, base: payload.base,
        draft: payload.draft, body: operation.marker,
      });
      return this.pullArtifact(marker, response.data);
    }
    const existing = await this.findByMarker(marker);
    const number = Number(payload.number ?? existing?.number);
    if (!Number.isSafeInteger(number)) throw new Error('GitHub update requires a durable issue or PR number');
    if (operation.operationKind === 'update_issue' || operation.operationKind === 'update_pull_request') {
      const route = operation.operationKind === 'update_issue'
        ? 'PATCH /repos/{owner}/{repo}/issues/{issue_number}'
        : 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}';
      await this.octokit.request(route, {
        owner, repo, issue_number: number, pull_number: number,
        title: payload.title, body: payload.acceptanceCriteria ? this.issueBody(payload, operation.marker) : undefined,
        state: payload.state,
      });
      return this.findByMarker(marker);
    }
    if (operation.operationKind === 'sync_labels') {
      await this.octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner, repo, issue_number: number, labels: payload.labels,
      });
      return this.findByMarker(marker);
    }
    if (operation.operationKind === 'create_comment') {
      const response = await this.octokit.request<CommentData>('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: number, body: `${String(payload.body ?? '')}\n\n${operation.marker}`,
      });
      return {
        remoteId: String(response.data.id), number, url: response.data.html_url,
        repository: marker.repository, kind: 'comment', marker: operation.marker,
        headBranch: marker.head, baseBranch: marker.base, state: 'present', body: response.data.body,
      };
    }
    if (operation.operationKind === 'merge_pull_request') {
      if (!existing?.number || existing.headSha !== payload.expectedHeadSha || existing.baseSha !== payload.expectedBaseSha) {
        throw new Error('Pull request head/base changed after validation; refusing merge');
      }
      await this.octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
        owner, repo, pull_number: existing.number, sha: payload.expectedHeadSha,
        merge_method: payload.method,
      });
      return this.findByMarker(marker);
    }
    throw new Error(`Unsupported goal GitHub operation: ${operation.operationKind}`);
  }

  async inspectGoal(_repository: string, markers: GoalArtifactMarker[]): Promise<GoalGitHubRemoteArtifact[]> {
    const results = await Promise.all(markers.map((marker) => this.findByMarker(marker)));
    return results.filter((artifact): artifact is GoalGitHubRemoteArtifact => artifact !== null);
  }

  async branchHasDiff(repository: string, head: string, base: string): Promise<boolean> {
    const { owner, repo } = repositoryParts(repository);
    const response = await this.octokit.request<{ ahead_by: number }>('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner, repo, basehead: `${base}...${head}`,
    });
    return response.data.ahead_by > 0;
  }

  private issueBody(payload: Record<string, unknown>, marker: string): string {
    const criteria = Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria.map((criterion) => `- [ ] ${String(criterion)}`).join('\n')
      : '';
    return `${criteria}\n\n${marker}`.trim();
  }

  private issueArtifact(marker: GoalArtifactMarker, issue: IssueData): GoalGitHubRemoteArtifact {
    return {
      remoteId: String(issue.id), number: issue.number, url: issue.html_url,
      repository: marker.repository, kind: marker.artifactKind, marker: buildGoalArtifactMarker(marker),
      headBranch: marker.head, baseBranch: marker.base,
      state: issue.state === 'open' ? 'present' : 'closed', labels: labelsOf(issue), body: issue.body,
    };
  }

  private pullArtifact(marker: GoalArtifactMarker, pull: PullData): GoalGitHubRemoteArtifact {
    return {
      ...this.issueArtifact(marker, pull), kind: 'pull_request',
      headBranch: pull.head.ref, baseBranch: pull.base.ref, headSha: pull.head.sha, baseSha: pull.base.sha,
      state: pull.merged_at ? 'merged' : pull.state === 'open' ? 'present' : 'closed',
    };
  }
}

/** Reads GitHub checks/reviews at the exact PR head used by the merge gate. */
export class ProPRGoalValidationPort implements GoalValidationPort {
  constructor(private readonly octokit: OctokitLike) {}

  async validate(input: GoalValidationRequest): Promise<Array<Omit<GoalValidationEvidenceInput, 'leaseOwner' | 'leaseEpoch'>>> {
    const { owner, repo } = repositoryParts(input.repository);
    const [checks, reviews] = await Promise.all([
      this.octokit.paginate<{ name: string; conclusion: string | null }>('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner, repo, ref: input.headSha, per_page: 100,
      }),
      this.octokit.paginate<{ state: string }>('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner, repo, pull_number: input.pullRequestNumber, per_page: 100,
      }),
    ]);
    const expected = [...(input.policy.expectedChecks ?? [])].sort();
    const passingChecks = checks.filter((check) => check.conclusion === 'success').map((check) => check.name).sort();
    const ciPassed = expected.every((name) => passingChecks.includes(name));
    const reviewPassed = reviews.some((review) => review.state === 'APPROVED');
    return [
      this.evidence(input, 'ci', { passed: ciPassed, result: { checks }, expectedChecks: expected }),
      this.evidence(input, 'review', { passed: reviewPassed, result: { reviews } }),
      this.evidence(input, 'freshness', { passed: true, result: { observedHeadSha: input.headSha } }),
    ];
  }

  private evidence(
    input: GoalValidationRequest,
    kind: 'ci' | 'review' | 'freshness',
    outcome: { passed: boolean; result: Record<string, unknown>; expectedChecks?: string[] }
  ): Omit<GoalValidationEvidenceInput, 'leaseOwner' | 'leaseEpoch'> {
    return {
      kind, headSha: input.headSha, baseSha: input.baseSha, policyHash: input.policy.policyHash,
      expectedChecks: outcome.expectedChecks, result: outcome.result,
      status: outcome.passed ? 'passed' : 'failed',
    };
  }
}

export interface ProductionGoalOrchestratorOptions {
  controller: GoalControllerOptions;
  supervisor: GoalSupervisorOptions;
  runtime: GoalRuntimePort;
  readinessPolicy(goalId: string): Promise<GoalReadinessPolicy>;
  database: Knex;
  github?: GoalGitHubPort;
  validation?: GoalValidationPort;
}

/** Owns startup recovery and the scheduler lifecycle in the real worker database. */
export class ProductionGoalOrchestrator {
  private readonly supervisor: GoalControllerSupervisor;
  private readonly controller: GoalController;

  constructor(private readonly options: ProductionGoalOrchestratorOptions) {
    const database = options.database;
    const goals = new GoalRepository(database);
    const orchestration = new GoalOrchestrationRepository(database);
    const events: GoalEventPort = {
      emit: async (input) => {
        const payload = JSON.stringify(input.payload);
        await goals.appendEvent(input.goalId, {
          kind: 'domain', eventType: input.type, payload: input.payload,
          idempotencyKey: `orchestration:${input.type}:${crypto.createHash('sha256').update(payload).digest('hex')}`,
          ...input.controllerFence,
        });
      },
    };
    this.controller = new GoalController(
      goals, orchestration, options.runtime, options.github ?? unavailableGitHubPort,
      events, options.controller, options.validation
    );
    this.supervisor = new GoalControllerSupervisor(goals, orchestration, options.supervisor);
  }

  async start(): Promise<void> {
    await this.supervisor.start(async (goalId, fence) => {
      await this.controller.tick(goalId, fence, await this.options.readinessPolicy(goalId));
    });
  }

  stop(): Promise<void> {
    return this.supervisor.stop();
  }
}

export async function createProductionGoalOrchestrator(
  options: Omit<ProductionGoalOrchestratorOptions, 'github' | 'validation' | 'database'> & { database?: Knex }
): Promise<ProductionGoalOrchestrator> {
  const { getAuthenticatedOctokit } = await import('../../auth/githubAuth.js');
  const octokit = await getAuthenticatedOctokit() as unknown as OctokitLike;
  const database = options.database ?? (await import('../../db/connection.js')).db;
  return new ProductionGoalOrchestrator({
    ...options, database,
    github: new ProPRGoalGitHubPort(octokit),
    validation: new ProPRGoalValidationPort(octokit),
  });
}

const unavailableGitHubPort: GoalGitHubPort = {
  async findByMarker() { throw new Error('Production GitHub port was not configured'); },
  async execute() { throw new Error('Production GitHub port was not configured'); },
  async inspectGoal() { throw new Error('Production GitHub port was not configured'); },
  async branchHasDiff() { throw new Error('Production GitHub port was not configured'); },
};
