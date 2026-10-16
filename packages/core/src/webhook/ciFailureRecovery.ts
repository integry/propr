import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { isAutoCiFollowupEnabledForRepository, getNonBlockingChecksForRepository } from '../daemon/configLoader.js';
import { isNonBlockingCheck } from './nonBlockingChecks.js';
import { isFailingCheckRunConclusion, postCiFailureFollowup, type CiFailureEvidence } from './ciFailureFollowup.js';

/**
 * Reconcile failures observed while waiting for CI, including missed webhooks.
 * Strict (the Routing resume resync): an unreadable repository configuration
 * throws instead of reading as "disabled" or "no non-blocking checks", and a
 * follow-up suppressed by another producer's claim counts only once it exists.
 */
// eslint-disable-next-line max-params -- the existing positional signature plus the strict-catch-up options
export async function recoverCiFailureFollowups(
    owner: string, repo: string, prNumber: number, headSha: string, options: { strict?: boolean } = {},
): Promise<void> {
    const isEnabled = (o: string, r: string) => isAutoCiFollowupEnabledForRepository(o, r, undefined, options);
    if (!await isEnabled(owner, repo)) return;
    const octokit = await getAuthenticatedOctokit();
    const nonBlocking = await getNonBlockingChecksForRepository(owner, repo, undefined, options);
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
        if (pr.state !== 'open') return;
        if (pr.head.sha !== headSha) {
            // Strict: the head listed for this pass is stale, so the caller must re-read the PR.
            if (options.strict) throw new Error(`Head of ${owner}/${repo}#${prNumber} moved during CI-failure recovery`);
            return;
        }
        // Shares the webhook's atomic claim and durable comment deduplication.
        const result = await postCiFailureFollowup({ owner, repo, prNumber, evidence }, `ci-recovery-${prNumber}`, { isEnabled, strict: options.strict });
        // Strict: a claim is exclusion, not publication; retry once it publishes or its lease lapses.
        if (options.strict && result.reason === 'in_flight') {
            throw new Error(`Failed-CI follow-up for ${owner}/${repo}#${prNumber} (${evidence.source}) is claimed but not yet published`);
        }
    }
}
