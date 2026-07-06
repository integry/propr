/**
 * Implementation Commands
 *
 * CLI commands for implementing issues using the ProPR backend.
 * Provides the `issue` command group with the `implement` subcommand.
 */

import { Command } from "commander";
import {
  implementIssue,
  getTaskStatus,
  TaskState,
  TaskStatus,
} from "../api/index.js";
import { normalizeProjectSlug } from "../utils/index.js";

/**
 * Terminal states that indicate a task has finished processing.
 */
const TERMINAL_STATES: TaskState[] = ["completed", "failed", "cancelled"];

/**
 * Poll interval in milliseconds.
 */
const POLL_INTERVAL_MS = 3000;

/**
 * Maximum wait time in milliseconds (10 minutes).
 */
const MAX_WAIT_MS = 600000;

/**
 * Parses an issue identifier in the format "draft-id/issue-number" or "draft-id:issue-number".
 */
function parseIssueId(issueId: string): { draftId: string; issueNumber: number } | null {
  const separatorMatch = issueId.match(/^(.+)[\/:](\d+)$/);
  if (separatorMatch) {
    const draftId = separatorMatch[1];
    const issueNumber = parseInt(separatorMatch[2], 10);
    if (!isNaN(issueNumber) && issueNumber > 0) {
      return { draftId, issueNumber };
    }
  }
  return null;
}

/**
 * Resolves the repository assertion sent with an implement request.
 *
 * Only an explicit -p/--project becomes an assertion. The configured default
 * project is deliberately NOT used here: the draft alone determines the
 * repository, and sending the default would reject implements of drafts in
 * other repositories.
 */
export function resolveOptionalImplementationRepository(
  options: { project?: string }
): string | undefined {
  if (options.project === undefined) {
    return undefined;
  }
  const normalized = normalizeProjectSlug(options.project);
  if (normalized === null) {
    throw new Error("Invalid project format. Expected 'owner/repo'.");
  }
  return normalized;
}

/**
 * Formats the current task state for display.
 */
function formatState(state: TaskState | string): string {
  const stateMap: Record<string, string> = {
    pending: "Pending",
    queued: "Queued",
    processing: "Processing",
    claude_execution: "Executing",
    post_processing: "Post-processing",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return stateMap[state] || state;
}

/**
 * Polls the task status until it reaches a terminal state.
 */
async function pollTaskStatus(taskId: string): Promise<TaskStatus> {
  const startTime = Date.now();
  let lastState = "";

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const status = await getTaskStatus(taskId);

    if (status.currentState !== lastState) {
      console.log(`Status: ${formatState(status.currentState)}`);
      lastState = status.currentState;
    }

    if (TERMINAL_STATES.includes(status.currentState as TaskState)) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const finalStatus = await getTaskStatus(taskId);
  return finalStatus;
}

/**
 * Creates the `issue` command group.
 */
export function createIssueCommand(): Command {
  const issue = new Command("issue")
    .description("Manage GitHub issue implementation")
    .addHelpText("after", `
Examples:
  $ propr issue implement abc123/1
  $ propr issue implement abc123:42 --wait
  $ propr issue implement abc123/1 -a claude --wait --auto-merge
`);

  issue
    .command("implement <issue-id>")
    .description("Implement a GitHub issue from a plan using AI agents")
    .option("-w, --wait", "Wait for the implementation to complete")
    .option("-p, --project <project>", "Assert the issue's repository (owner/repo); the request fails if it does not match")
    .option("-a, --agent <agent>", "Agent alias to use for implementation")
    .option("-m, --model <model>", "Model name to use for implementation")
    .option("--epic", "Create an Epic PR to collect all related PRs")
    .option("--auto-merge", "Enable auto-merge for the created PR")
    .addHelpText("after", `
Argument:
  issue-id    Format: <draft-id>/<issue-number> or <draft-id>:<issue-number>

Examples:
  $ propr issue implement abc123/1
  $ propr issue implement abc123:42 --wait
  $ propr issue implement abc123/1 -a claude -m claude-sonnet-4-20250514 --wait
  $ propr issue implement abc123/1 --epic --auto-merge
`)
    .action(
      async (
        issueId: string,
        options: {
          wait?: boolean;
          project?: string;
          agent?: string;
          model?: string;
          epic?: boolean;
          autoMerge?: boolean;
        }
      ) => {
        try {
          const parsed = parseIssueId(issueId);
          if (!parsed) {
            console.error(
              "Error: Invalid issue ID format. Expected: <draft-id>/<issue-number> or <draft-id>:<issue-number>"
            );
            console.error("");
            console.error("Examples:");
            console.error("  propr issue implement abc123/1");
            console.error("  propr issue implement draft-uuid-here:42");
            process.exit(1);
          }

          const { draftId, issueNumber } = parsed;
          const repository = resolveOptionalImplementationRepository(options);

          console.log(`Implementing issue #${issueNumber} from draft ${draftId}...`);

          const result = await implementIssue(draftId, issueNumber, {
            repository,
            agent_alias: options.agent,
            model_name: options.model,
            useEpic: options.epic,
            autoMerge: options.autoMerge,
          });

          if (!result.success) {
            console.error(`Error: ${result.message}`);
            process.exit(1);
          }

          console.log(result.message);

          if (result.taskId) {
            console.log(`Task ID: ${result.taskId}`);
          }

          if (!options.wait) {
            if (result.taskId) {
              console.log("");
              console.log(
                "Use 'propr issue implement <issue-id> --wait' to wait for completion."
              );
            }
            return;
          }

          if (!result.taskId) {
            console.log("");
            console.log(
              "Note: No task ID returned. The implementation may be triggered asynchronously."
            );
            return;
          }

          console.log("");
          console.log("Waiting for implementation to complete...");

          const finalStatus = await pollTaskStatus(result.taskId);

          console.log("");

          if (finalStatus.isCompleted) {
            console.log("Implementation completed successfully!");
            if (finalStatus.prNumber) {
              console.log(`Pull Request: #${finalStatus.prNumber}`);
            }
            if (finalStatus.prUrl) {
              console.log(`PR URL: ${finalStatus.prUrl}`);
            }
          } else if (finalStatus.isFailed) {
            console.error("Implementation failed.");
            if (finalStatus.failureReason) {
              console.error(`Reason: ${finalStatus.failureReason}`);
            }
            process.exit(1);
          } else {
            console.log(
              `Implementation is still ${formatState(finalStatus.currentState)}.`
            );
            console.log(`Task ID: ${result.taskId}`);
            console.log("You can check the status later using the ProPR dashboard.");
          }
        } catch (error) {
          console.error(
            `Error implementing issue: ${(error as Error).message}`
          );
          process.exit(1);
        }
      }
    );

  return issue;
}
