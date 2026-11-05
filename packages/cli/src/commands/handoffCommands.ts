/**
 * `propr handoffs` — operator recovery for PR follow-up publication handoffs.
 *
 * Talks to the admin-only `/api/admin/followup-handoffs` endpoints, so every
 * subcommand requires an instance administrator token.
 */

import { Command } from "commander";
import {
  getFollowupHandoff,
  listFollowupHandoffs,
  releaseFollowupHandoff,
  resumeFollowupHandoff,
  type FollowupHandoffRecoverySummary,
  type FollowupHandoffStatus,
} from "../api/followupHandoffs.js";
import { ApiError } from "../api/errors.js";

export interface HandoffTarget {
  owner: string;
  repo: string;
  pullRequest: number;
}

const REPOSITORY_ARGUMENT = /^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/;

/** Parses the `<owner/repo> <pr>` argument pair; throws a user-facing error when malformed. */
export function parseHandoffTarget(repository: string, pr: string): HandoffTarget {
  if (!REPOSITORY_ARGUMENT.test(repository)) {
    throw new Error(`Invalid repository "${repository}"; expected owner/repo`);
  }
  if (!/^[1-9]\d*$/.test(pr)) {
    throw new Error(`Invalid pull request number "${pr}"; expected a positive integer`);
  }
  const [owner, repo] = repository.split("/");
  return { owner, repo, pullRequest: Number(pr) };
}

export function formatHandoffStatus(status: FollowupHandoffStatus): string[] {
  const reason = status.statusReason ? ` (${status.statusReason})` : "";
  return [
    `${status.repository}#${status.pullRequest}`,
    `  Phase:            ${status.phase}`,
    `  Status:           ${status.status}${reason}`,
    `  Settlement:       ${status.settlement ?? "(none)"}`,
    `  Liveness:         ${status.liveness}`,
    `  Branch:           ${status.branchName}`,
    `  Task:             ${status.taskId}`,
    `  Predecessors:     ${status.predecessorTaskIds.length ? status.predecessorTaskIds.join(", ") : "(none)"}`,
    `  Successor task:   ${status.successorTaskId ?? "(none)"}`,
    `  Retained worktree: ${status.retainedWorktreePath}`,
    `  Commit:           ${status.commitHash ?? "(none)"}`,
    `  Comment:          ${status.completionCommentUrl ?? "(not published)"}`,
    `  Operator authorized: ${status.operatorAuthorized ? "yes" : "no"}`,
    `  Next action:      ${status.nextAction}`,
  ];
}

export function formatRecoverySummary(summary: FollowupHandoffRecoverySummary): string {
  const parts = [
    `inspected ${summary.inspected}`, `published ${summary.published}`, `no changes ${summary.noChanges}`,
    `settled ${summary.settled}`, `cleanup pending ${summary.cleanupPending}`, `live agent ${summary.skippedLiveAgent}`,
    `failed closed ${summary.failedClosed}`, `awaiting operator ${summary.awaitingOperator}`,
    `locked ${summary.lockedByOtherWriter}`, `errors ${summary.errors}`,
  ];
  return `Recovery pass: ${parts.join(", ")}`;
}

/** Turns an API refusal into an actionable operator message. */
export function handoffErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const response = (error.response ?? {}) as { code?: string; reason?: string; error?: string };
    const code = response.code ?? response.reason;
    if (code === "requires_cancellation_authorization") {
      return "The retained work was cancelled by the user. Re-run with --authorize-cancelled to explicitly authorize publishing it.";
    }
    if (code === "cancellation_authorization_unavailable") {
      return "Cancellation authorization was not granted: the handoff is missing, not operator-held, changed, or its pull request lease is held by another writer. Inspect it first.";
    }
    if (code === "worktree_holds_unpublished_work") {
      return "Release refused: the retained worktree still holds unpublished work. Inspect it, then re-run with --force to detach anyway (files and commits are kept).";
    }
    if (code === "branch_still_registered") {
      return "Release refused: a Git worktree registration still holds the branch (for example a retained worktree whose directory is gone). Repair or remove that registration in the repository, then re-run release.";
    }
    if (code === "worktree_registrations_unavailable") {
      return "Release refused: the repository's Git worktree registrations could not be read, so branch release is unproven. Restore repository access, then re-run release.";
    }
    if (code === "cancelled_claims_withdrawal_failed") {
      return "Release refused: the cancelled request's comments could not be withdrawn from the pending list, so releasing could let them run. Restore Redis access, then re-run release.";
    }
    if (code) return `${error.message} (${code})`;
  }
  return (error as Error).message;
}

function fail(error: unknown): never {
  console.error(`Error: ${handoffErrorMessage(error)}`);
  process.exit(1);
}

function printStatus(status: FollowupHandoffStatus | null): void {
  if (!status) {
    console.log("The handoff is finalized; no record remains.");
    return;
  }
  for (const line of formatHandoffStatus(status)) console.log(line);
}

export function createHandoffsCommand(): Command {
  const handoffs = new Command("handoffs")
    .description("Operate PR follow-up publication handoffs (instance administrators)");

  handoffs.command("list")
    .description("List every tracked follow-up publication handoff")
    .option("-j, --json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const { handoffs: statuses } = await listFollowupHandoffs();
        if (options.json) { console.log(JSON.stringify(statuses, null, 2)); return; }
        if (statuses.length === 0) { console.log("No follow-up handoffs are tracked."); return; }
        for (const status of statuses) printStatus(status);
      } catch (error) { fail(error); }
    });

  handoffs.command("inspect <owner/repo> <pr>")
    .description("Show one handoff's phase, status, liveness and retained work")
    .option("-j, --json", "Output JSON")
    .action(async (repository: string, pr: string, options: { json?: boolean }) => {
      try {
        const { owner, repo, pullRequest } = parseHandoffTarget(repository, pr);
        const { status } = await getFollowupHandoff(owner, repo, pullRequest);
        if (options.json) { console.log(JSON.stringify(status, null, 2)); return; }
        printStatus(status);
      } catch (error) { fail(error); }
    });

  handoffs.command("resume <owner/repo> <pr>")
    .description("Re-arm an operator-held handoff and run a recovery pass for this PR only")
    .option("--authorize-cancelled", "Explicitly authorize publishing work the user cancelled")
    .option("-j, --json", "Output JSON")
    .action(async (repository: string, pr: string, options: { authorizeCancelled?: boolean; json?: boolean }) => {
      try {
        const { owner, repo, pullRequest } = parseHandoffTarget(repository, pr);
        const result = await resumeFollowupHandoff(owner, repo, pullRequest, { authorizeCancelled: options.authorizeCancelled });
        if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(formatRecoverySummary(result.summary));
        printStatus(result.status);
      } catch (error) { fail(error); }
    });

  handoffs.command("release <owner/repo> <pr>")
    .description("Stop tracking a handoff; never deletes retained files or commits")
    .option("--force", "Detach the worktree HEAD even while unpublished work exists")
    .option("-j, --json", "Output JSON")
    .action(async (repository: string, pr: string, options: { force?: boolean; json?: boolean }) => {
      try {
        const { owner, repo, pullRequest } = parseHandoffTarget(repository, pr);
        const result = await releaseFollowupHandoff(owner, repo, pullRequest, { force: options.force });
        if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`Released ${repository}#${pullRequest}; retained files and commits are kept in place.`);
      } catch (error) { fail(error); }
    });

  return handoffs;
}
