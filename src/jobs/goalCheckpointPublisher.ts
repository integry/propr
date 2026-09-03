import { createHash, randomUUID } from 'node:crypto';
import {
    AI_COMMIT_AUTHOR,
    commitChanges,
    db,
    getAuthenticatedOctokit,
    getRepoUrl,
    parseGoalArtifacts,
    pushBranch,
    type GoalArtifact,
    type GoalJobData,
} from '@propr/core';

export type GoalCheckpointKind = 'bootstrap' | 'manual' | 'automatic' | 'final';

export interface GoalCheckpointRequest {
    checkpointId?: string;
    kind: GoalCheckpointKind;
    commitMessage?: string;
    turnId?: string;
}

interface PublishableGoal {
    goal_id: string;
    owner_id: string;
    repository: string;
    objective: string;
    launch_strategy: string;
    base_branch: string | null;
    branch_name: string | null;
    worktree_path: string | null;
    requested_model: string;
    run_generation: number;
    run_claim: string | null;
    result_state: string | null;
    final_pr_number: number | null;
    final_pr_url: string | null;
    artifact_refs: string | GoalArtifact[] | null;
    checkpoint_interval_minutes: number | null;
}

interface PullRequestInfo {
    number: number;
    url: string;
    state: string;
    draft: boolean;
}

const publicationLocks = new Map<string, Promise<unknown>>();

function checkpointMessage(goal: PublishableGoal, request: GoalCheckpointRequest): string {
    if (request.commitMessage?.trim()) return request.commitMessage.trim().slice(0, 500);
    const objective = goal.objective.replace(/\s+/g, ' ').trim().slice(0, 72);
    if (request.kind === 'bootstrap') return `chore(goal): initialize draft for ${objective}`;
    if (request.kind === 'final') return `feat(goal): publish final checkpoint for ${objective}`;
    return `feat(goal): publish ${request.kind} checkpoint for ${objective}`;
}

function checkpointKey(goal: PublishableGoal, request: GoalCheckpointRequest): string {
    if (request.checkpointId) return request.checkpointId;
    if (request.kind === 'bootstrap') return `goal-bootstrap:${goal.goal_id}`;
    if (request.kind === 'final') return `goal-final:${goal.goal_id}:${goal.run_generation}`;
    return `goal-${request.kind}:${goal.goal_id}:${goal.run_generation}:${randomUUID()}`;
}

async function resolveBaseBranch(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    goal: PublishableGoal,
): Promise<string> {
    if (goal.base_branch) return goal.base_branch;
    const [owner, repo] = goal.repository.split('/');
    const response = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    return response.data.default_branch;
}

async function findDraftPr(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    goal: PublishableGoal,
    baseBranch: string,
): Promise<PullRequestInfo | null> {
    const [owner, repo] = goal.repository.split('/');
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner, repo, state: 'open', head: `${owner}:${goal.branch_name}`, base: baseBranch,
    });
    const pull = response.data.find(candidate =>
        candidate.head.ref === goal.branch_name && candidate.base.ref === baseBranch);
    return pull ? {
        number: pull.number,
        url: pull.html_url,
        state: pull.state,
        draft: pull.draft ?? false,
    } : null;
}

async function createDraftPr(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    goal: PublishableGoal,
    baseBranch: string,
): Promise<PullRequestInfo> {
    const existing = await findDraftPr(octokit, goal, baseBranch);
    if (existing) {
        if (!existing.draft) throw new Error('The goal branch already has an open non-draft pull request');
        return existing;
    }
    const [owner, repo] = goal.repository.split('/');
    const title = `[Goal by ${goal.requested_model}] ${goal.objective.replace(/\s+/g, ' ').trim().slice(0, 160)}`;
    const body = [
        '## Goal implementation',
        '',
        'This draft PR is created and checkpointed by ProPR while the goal agent works.',
        '',
        `**Goal:** ${goal.objective}`,
        `**Goal ID:** \`${goal.goal_id}\``,
        `**Checkpoint interval:** ${goal.checkpoint_interval_minutes} minutes`,
    ].join('\n');
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                owner, repo, title, head: goal.branch_name!, base: baseBranch, body, draft: true,
            });
            return {
                number: response.data.number,
                url: response.data.html_url,
                state: response.data.state,
                draft: response.data.draft ?? true,
            };
        } catch (error) {
            lastError = error;
            const raced = await findDraftPr(octokit, goal, baseBranch);
            if (raced) return raced;
            if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
        }
    }
    throw lastError;
}

function withFinalPrArtifact(goal: PublishableGoal, pull: PullRequestInfo): GoalArtifact[] {
    const artifact: GoalArtifact = {
        type: 'pull_request', number: pull.number, url: pull.url,
        state: pull.state, draft: pull.draft,
    };
    const existing = parseGoalArtifacts(goal.artifact_refs);
    return [...existing.filter(item => item.type !== 'pull_request' || item.number !== pull.number), artifact];
}

function artifactStats(artifacts: GoalArtifact[]) {
    const issues = artifacts.filter(artifact => artifact.type === 'issue');
    const pulls = artifacts.filter(artifact => artifact.type === 'pull_request');
    return {
        issues: issues.length,
        openIssues: issues.filter(artifact => artifact.state === 'open').length,
        pullRequests: pulls.length,
        openPullRequests: pulls.filter(artifact => artifact.state === 'open').length,
    };
}

// Publication deliberately keeps Git, GitHub, and persistence fencing in one serialized critical section.
// eslint-disable-next-line complexity
async function publishLocked(
    job: GoalJobData,
    request: GoalCheckpointRequest,
): Promise<{ commitSha: string | null; pullRequest: PullRequestInfo }> {
    const goal = await db<PublishableGoal>('goals').where({
        goal_id: job.goalId,
        run_generation: job.generation,
        run_claim: job.claimId,
    }).whereNull('result_state').first();
    if (!goal) throw new Error('Goal checkpoint attempt was superseded');
    if (goal.launch_strategy !== 'direct') throw new Error('Worker checkpoints only apply to direct goals');
    if (!goal.worktree_path || !goal.branch_name) throw new Error('Goal checkpoint requires a saved worktree and branch');

    const checkpointId = request.checkpointId ?? randomUUID();
    const idempotencyKey = checkpointKey(goal, request);
    const operation = request.kind === 'manual' ? 'goal.checkpoint' : `goal.checkpoint.${request.kind}`;
    const payloadHash = createHash('sha256').update(JSON.stringify({
        goalId: goal.goal_id, kind: request.kind, commitMessage: request.commitMessage ?? null,
    })).digest('hex');
    const existingCheckpoint = request.checkpointId
        ? await db('goal_checkpoints').where({ checkpoint_id: request.checkpointId, goal_id: goal.goal_id }).first()
        : await db('goal_checkpoints').where({ owner_id: goal.owner_id, idempotency_key: idempotencyKey }).first();
    if (existingCheckpoint?.state === 'completed' || existingCheckpoint?.state === 'skipped') {
        if (!goal.final_pr_number || !goal.final_pr_url) throw new Error('Completed checkpoint is missing its draft PR identity');
        return {
            commitSha: existingCheckpoint.commit_sha ?? null,
            pullRequest: {
                number: goal.final_pr_number, url: goal.final_pr_url, state: 'open', draft: true,
            },
        };
    }
    if (existingCheckpoint) {
        const claimed = await db('goal_checkpoints').where({
            checkpoint_id: existingCheckpoint.checkpoint_id,
            goal_id: goal.goal_id,
        }).whereIn('state', ['pending', 'failed']).update({
            state: 'processing', started_at: db.fn.now(), completed_at: null,
            error: null, delivered_turn_id: request.turnId ?? null,
        });
        if (claimed !== 1 && existingCheckpoint.state !== 'processing') {
            throw new Error('Goal checkpoint request changed before publication');
        }
    } else {
        await db('goal_checkpoints').insert({
            checkpoint_id: checkpointId,
            goal_id: goal.goal_id,
            owner_id: goal.owner_id,
            idempotency_key: idempotencyKey,
            operation,
            payload_hash: payloadHash,
            kind: request.kind,
            commit_message: request.commitMessage ?? null,
            state: 'processing',
            requested_generation: job.generation,
            requested_claim: job.claimId,
            delivered_turn_id: request.turnId ?? null,
            created_at: db.fn.now(),
            started_at: db.fn.now(),
        });
    }

    const recordId = existingCheckpoint?.checkpoint_id ?? checkpointId;
    try {
        const commit = await commitChanges(
            goal.worktree_path,
            checkpointMessage(goal, request),
            AI_COMMIT_AUTHOR,
            { issueTitle: goal.objective, allowEmpty: request.kind === 'bootstrap' },
        );
        const octokit = await getAuthenticatedOctokit();
        const auth = await octokit.auth({ type: 'installation' }) as { token: string };
        // Push even when this invocation found no new files. A previous
        // publication attempt may have created the commit locally and then
        // failed before its push completed.
        const [repoOwner, repoName] = goal.repository.split('/');
        await pushBranch(goal.worktree_path, goal.branch_name, {
            repoUrl: getRepoUrl({ repoOwner, repoName }), authToken: auth.token,
        });
        const baseBranch = await resolveBaseBranch(octokit, goal);
        const pull = await createDraftPr(octokit, goal, baseBranch);
        const artifacts = withFinalPrArtifact(goal, pull);
        const updated = await db('goals').where({
            goal_id: job.goalId,
            run_generation: job.generation,
            run_claim: job.claimId,
        }).whereNull('result_state').update({
            base_branch: baseBranch,
            final_pr_number: pull.number,
            final_pr_url: pull.url,
            artifact_refs: JSON.stringify(artifacts),
            artifact_stats: JSON.stringify(artifactStats(artifacts)),
            last_checkpoint_at: db.fn.now(),
            ...(commit ? {
                last_checkpoint_commit_sha: commit.commitHash,
                checkpoint_count: db.raw('checkpoint_count + 1'),
            } : {}),
            checkpoint_error: null,
            updated_at: db.fn.now(),
        });
        if (updated !== 1) throw new Error('Goal checkpoint result was fenced');
        await db('goal_checkpoints').where({ checkpoint_id: recordId }).update({
            state: commit ? 'completed' : 'skipped',
            commit_sha: commit?.commitHash ?? null,
            pr_number: pull.number,
            pr_url: pull.url,
            completed_at: db.fn.now(),
        });
        return { commitSha: commit?.commitHash ?? null, pullRequest: pull };
    } catch (error) {
        const message = (error as Error).message;
        await db('goal_checkpoints').where({ checkpoint_id: recordId }).update({
            state: 'failed', error: message, completed_at: db.fn.now(),
        });
        await db('goals').where({
            goal_id: job.goalId, run_generation: job.generation, run_claim: job.claimId,
        }).whereNull('result_state').update({ checkpoint_error: message, updated_at: db.fn.now() });
        throw error;
    }
}

export async function publishDirectGoalCheckpoint(
    job: GoalJobData,
    request: GoalCheckpointRequest,
): Promise<{ commitSha: string | null; pullRequest: PullRequestInfo }> {
    const previous = publicationLocks.get(job.goalId) ?? Promise.resolve();
    const publication = previous.catch(() => undefined).then(() => publishLocked(job, request));
    publicationLocks.set(job.goalId, publication);
    try {
        return await publication;
    } finally {
        if (publicationLocks.get(job.goalId) === publication) publicationLocks.delete(job.goalId);
    }
}
