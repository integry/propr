import {
    appendVisualPreviewSection,
    getAuthenticatedOctokit,
    logger,
    prepareVisualPreviewEvidence,
    renderVisualPreviewSection,
    renderVisualPreviewUploadFailureSection,
    VISUAL_PREVIEW_MARKER,
} from '@propr/core';
import {
    isVisualPreviewUploadAuthenticationError,
    publishPullRequestVisualPreviews,
    type PublishPullRequestVisualPreviewOptions,
} from '../github/visualPreviewAttachments.js';

interface GoalVisualPreviewTarget {
    goal_id: string;
    repository: string;
    objective: string;
    checkpoint_interval_minutes: number | null;
    worktree_path: string | null;
}

type GoalVisualPreviewPublicationOverrides = Pick<
    PublishPullRequestVisualPreviewOptions,
    'authToken' | 'storeOriginals' | 'trustedConnectOrigin' | 'uploadAsset'
>;

function withoutPublishedVisualPreviews(body: string): string {
    const markerIndex = body.lastIndexOf(VISUAL_PREVIEW_MARKER);
    if (markerIndex < 0) return body;
    return body.slice(0, markerIndex).trimEnd().replace(/\n\n---\s*$/, '').trimEnd();
}

export function buildGoalPullRequestBody(
    goal: Pick<GoalVisualPreviewTarget, 'objective' | 'goal_id' | 'checkpoint_interval_minutes'>,
): string {
    return [
        '## Goal implementation',
        '',
        'This draft PR is created and checkpointed by ProPR while the goal agent works.',
        '',
        `**Goal:** ${goal.objective}`,
        `**Goal ID:** \`${goal.goal_id}\``,
        `**Checkpoint interval:** ${goal.checkpoint_interval_minutes} minutes`,
    ].join('\n');
}

export async function publishGoalVisualPreviews(
    goal: GoalVisualPreviewTarget,
    pull: { number: number },
    prepared: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>>,
    ...publication: [
        octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
        overrides?: GoalVisualPreviewPublicationOverrides,
    ]
): Promise<void> {
    const [octokit, publicationOverrides = {}] = publication;
    const { evidence } = prepared;
    if (evidence.assets.length === 0 && evidence.toolSuggestions.length === 0) return;
    const [owner, repo] = goal.repository.split('/');
    let baseBody = goal.checkpoint_interval_minutes == null ? null : buildGoalPullRequestBody(goal);
    try {
        const current = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo,
            pull_number: pull.number,
        }) as { data: { body?: string | null } };
        if (typeof current.data.body === 'string' && current.data.body.trim()) {
            baseBody = withoutPublishedVisualPreviews(current.data.body);
        }
    } catch (error) {
        logger.warn({ goalId: goal.goal_id, pullRequestNumber: pull.number, error: (error as Error).message }, 'Could not load the existing goal PR body before publishing previews');
    }
    if (baseBody == null) return;

    if (evidence.assets.length === 0) {
        try {
            await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner,
                repo,
                pull_number: pull.number,
                body: appendVisualPreviewSection(baseBody, renderVisualPreviewSection(evidence, {})),
            });
        } catch (error) {
            logger.warn({ goalId: goal.goal_id, pullRequestNumber: pull.number, error: (error as Error).message }, 'Could not publish goal visual preview tool suggestions');
        }
        return;
    }

    try {
        await publishPullRequestVisualPreviews({
            owner,
            repo,
            pullRequestNumber: pull.number,
            body: baseBody,
            evidence,
            worktreePath: goal.worktree_path!,
            octokit,
            ...publicationOverrides,
        });
        logger.info({ goalId: goal.goal_id, pullRequestNumber: pull.number, previewCount: evidence.assets.length }, 'Uploaded goal visual previews to draft PR');
    } catch (error) {
        logger.warn({ goalId: goal.goal_id, pullRequestNumber: pull.number, error: (error as Error).message }, 'Could not upload goal visual previews; publishing a text-only explanation');
        try {
            await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner,
                repo,
                pull_number: pull.number,
                body: appendVisualPreviewSection(baseBody, renderVisualPreviewUploadFailureSection(
                    evidence,
                    { authenticationFailure: isVisualPreviewUploadAuthenticationError(error) },
                )),
            });
        } catch (fallbackError) {
            logger.warn({ goalId: goal.goal_id, pullRequestNumber: pull.number, error: (fallbackError as Error).message }, 'Could not publish the goal visual preview upload explanation');
        }
    }
}
