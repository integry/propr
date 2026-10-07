import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isAutoCiFollowupEnabledForRepository, getNonBlockingChecksForRepository } from '../daemon/configLoader.js';
import { isNonBlockingCheck } from './nonBlockingChecks.js';
import { isFailingCheckRunConclusion, postCiFailureFollowup, type CiFailureEvidence } from './ciFailureFollowup.js';

/** Reconcile failures observed while waiting for CI, including missed webhooks. */
export async function recoverCiFailureFollowups(
    owner: string, repo: string, prNumber: number, headSha: string,
): Promise<void> {
    if (!await isAutoCiFollowupEnabledForRepository(owner, repo)) return;
    const octokit = await getAuthenticatedOctokit();
    const nonBlocking = await getNonBlockingChecksForRepository(owner, repo);
    const checks = await octokit.paginate('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner, repo, ref: headSha, filter: 'latest', per_page: 100,
    });
    const statuses = await octokit.paginate('GET /repos/{owner}/{repo}/commits/{ref}/statuses', {
        owner, repo, ref: headSha, per_page: 100,
    });
    const failures: CiFailureEvidence[] = checks
        .filter(check => check.status === 'completed' && isFailingCheckRunConclusion(check.conclusion))
        .map(check => ({
            kind: 'check_run', name: check.name, state: check.conclusion!, sha: headSha,
            source: `check-run:${check.name || check.id}`, checkRunId: check.id,
            url: check.details_url || check.html_url || '',
            fallbackExcerpt: [check.output.title, check.output.summary, check.output.text].filter(Boolean).join('\n\n'),
            annotationsCount: check.output.annotations_count,
        }));
    // Statuses are newest first; a superseded failure must never start work.
    const seen = new Set<string>();
    for (const status of statuses) {
        if (seen.has(status.context)) continue;
        seen.add(status.context);
        if (status.state !== 'failure' && status.state !== 'error') continue;
        failures.push({
            kind: 'status', name: status.context, state: status.state, sha: headSha,
            source: `status:${status.context}`, url: status.target_url || '',
            fallbackExcerpt: status.description || undefined,
        });
    }
    for (const evidence of failures) {
        if (isNonBlockingCheck(evidence.name, nonBlocking)) continue;
        const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: prNumber,
        });
        if (pr.state !== 'open' || pr.head.sha !== headSha) return;
        // Shares the webhook's atomic claim and durable comment deduplication.
        await postCiFailureFollowup({ owner, repo, prNumber, evidence }, `ci-recovery-${prNumber}`);
    }
}
