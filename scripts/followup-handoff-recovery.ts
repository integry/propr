#!/usr/bin/env tsx
/**
 * Non-destructive operator command for interrupted PR follow-up publication
 * handoffs. It never deletes retained worktrees or unpublished commits.
 * The same operations are available through the packaged surfaces: the
 * admin-only `/api/admin/followup-handoffs` API and `propr handoffs ...`.
 *
 *   tsx scripts/followup-handoff-recovery.ts list
 *   tsx scripts/followup-handoff-recovery.ts inspect <owner/repo> <pr>
 *   tsx scripts/followup-handoff-recovery.ts resume <owner/repo> <pr> [--authorize-cancelled]
 *   tsx scripts/followup-handoff-recovery.ts release <owner/repo> <pr> [--force]
 *
 * `resume` re-arms an operator-held handoff whose condition was repaired, then
 * runs one recovery pass strictly scoped to the named pull request; with
 * --authorize-cancelled it first grants explicit operator authorization to
 * publish work whose task the user cancelled (publication never happens
 * without it).
 * `release` stops tracking the handoff; it frees the branch only when the
 * worktree is settled, or detaches its HEAD in place with --force (all files
 * and commits stay in the worktree). Either way it is refused while a Git
 * worktree registration still holds the branch.
 */
import {
    authorizeCancelledFollowupHandoff,
    inspectFollowupHandoffs,
    recoverInterruptedFollowupHandoffs,
    releaseFollowupHandoffRecord,
    resumeOperatorHeldFollowupHandoff,
} from '../src/jobs/followupHandoffRecovery.js';
import type { FollowupHandoffKey } from '../src/jobs/followupHandoffStore.js';

function usage(): never {
    console.error('Usage: followup-handoff-recovery.ts <list|inspect|resume|release> [owner/repo] [pr] [--authorize-cancelled|--force]');
    process.exit(2);
}

function parseKey(repository?: string, pr?: string): FollowupHandoffKey {
    if (!repository || !repository.includes('/') || !pr || !/^\d+$/.test(pr)) usage();
    return { repository: repository.toLowerCase(), pull_request: Number(pr) };
}

function printStatuses(statuses: Awaited<ReturnType<typeof inspectFollowupHandoffs>>): void {
    if (statuses.length === 0) {
        console.log('No follow-up publication handoffs recorded.');
        return;
    }
    for (const { record, liveness, nextAction, predecessorTaskIds, successorTaskId } of statuses) {
        console.log([
            `${record.repository}#${record.pull_request}`,
            `  task:         ${record.task_id}`,
            `  predecessors: ${predecessorTaskIds.length ? predecessorTaskIds.join(', ') : '-'}`,
            `  successor:    ${successorTaskId ?? '-'}`,
            `  phase:        ${record.phase}`,
            `  status:       ${record.status}${record.status_reason ? ` (${record.status_reason})` : ''}`,
            `  liveness:     ${liveness}`,
            `  branch:       ${record.branch_name}`,
            `  worktree:     ${record.worktree_path}`,
            `  commit:       ${record.commit_hash ?? '-'}`,
            `  next action:  ${nextAction}`,
        ].join('\n'));
    }
}

async function resumeHandoff(key: FollowupHandoffKey, flag?: string): Promise<void> {
    if (flag === '--authorize-cancelled') {
        const authorized = await authorizeCancelledFollowupHandoff(key);
        if (!authorized) {
            console.error('No operator-held handoff to authorize, or it changed while authorizing; re-run inspect.');
            process.exit(1);
        }
        console.log('Operator authorization recorded; the cancelled work may now publish.');
    } else {
        const reactivated = await resumeOperatorHeldFollowupHandoff(key);
        if (!reactivated.resumed) {
            if (reactivated.reason === 'requires_cancellation_authorization') {
                console.error('This handoff was held for a user cancellation; re-run with --authorize-cancelled to explicitly authorize publication.');
            } else {
                console.error(`Cannot resume this handoff (${reactivated.reason}); re-run inspect.`);
            }
            process.exit(1);
        }
    }
    // Keyed recovery: side effects are limited to this pull request's handoff.
    const summary = await recoverInterruptedFollowupHandoffs({}, key);
    console.log(JSON.stringify(summary, null, 2));
    printStatuses(await inspectFollowupHandoffs({}, key));
}

async function main(): Promise<void> {
    const [command, repository, pr, flag] = process.argv.slice(2);
    switch (command) {
        case 'list': {
            printStatuses(await inspectFollowupHandoffs());
            return;
        }
        case 'inspect': {
            printStatuses(await inspectFollowupHandoffs({}, parseKey(repository, pr)));
            return;
        }
        case 'resume': {
            await resumeHandoff(parseKey(repository, pr), flag);
            return;
        }
        case 'release': {
            const key = parseKey(repository, pr);
            const result = await releaseFollowupHandoffRecord(key, { force: flag === '--force' });
            if (!result.released) {
                if (result.reason === 'branch_still_registered' || result.reason === 'worktree_registrations_unavailable') {
                    console.error(`Not released: ${result.reason}. A Git worktree registration still holds the branch, or the registrations could not be read; repair or remove the registration (or restore repository access), then re-run release.`);
                    process.exit(1);
                }
                console.error(`Not released: ${result.reason}. Settle the reported condition first; when the worktree holds unpublished work you may re-run with --force to detach its HEAD in place (files and commits are kept).`);
                process.exit(1);
            }
            console.log('Handoff released. The retained worktree and its contents were preserved.');
            return;
        }
        default:
            usage();
    }
}

main().then(() => process.exit(0), error => {
    console.error((error as Error).message);
    process.exit(1);
});
