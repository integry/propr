/**
 * Implementation Commands
 *
 * CLI commands for implementing issues using the ProPR backend.
 * Provides the `implement-issue` command with optional polling for task completion.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { resolveProject, ProjectResolutionError } from "../utils/index.js";
import {
  implementIssue,
  getTaskStatus,
  TaskState,
  TaskStatus,
} from "../api/index.js";

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
 *
 * @param issueId - The issue identifier string.
 * @returns An object containing draftId and issueNumber, or null if parsing fails.
 */
function parseIssueId(issueId: string): { draftId: string; issueNumber: number } | null {
  // Support both / and : as separators
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
 * Formats the current task state for display.
 *
 * @param state - The current task state.
 * @returns A human-readable status string.
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
 *
 * @param taskId - The task ID to poll.
 * @returns The final task status.
 */
async function pollTaskStatus(taskId: string): Promise<TaskStatus> {
  const startTime = Date.now();
  let lastState = "";

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const status = await getTaskStatus(taskId);

    // Print progress if state changed
    if (status.currentState !== lastState) {
      console.log(`Status: ${formatState(status.currentState)}`);
      lastState = status.currentState;
    }

    // Check if we've reached a terminal state
    if (TERMINAL_STATES.includes(status.currentState as TaskState)) {
      return status;
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Timeout - return the last known status
  const finalStatus = await getTaskStatus(taskId);
  return finalStatus;
}

/**
 * Registers implementation-related commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerImplementCommands(program: Command): void {
  program
    .command("implement-issue <issue-id>")
    .description("Implement a GitHub issue from a plan using AI agents")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-w, --wait", "Wait for the implementation to complete")
    .option("-a, --agent <agent>", "Agent alias to use for implementation")
    .option("-m, --model <model>", "Model name to use for implementation")
    .option("--epic", "Create an Epic PR to collect all related PRs")
    .option("--auto-merge", "Enable auto-merge for the created PR")
    .addHelpText("after", `
Argument:
  issue-id    Format: <draft-id>/<issue-number> or <draft-id>:<issue-number>

Examples:
  $ propr implement-issue abc123/1
  $ propr implement-issue abc123:42 --wait
  $ propr implement-issue abc123/1 -a claude -m claude-sonnet-4-20250514 --wait
  $ propr implement-issue abc123/1 --epic --auto-merge
`)
    .action(
      async (
        issueId: string,
        options: {
          project?: string;
          wait?: boolean;
          agent?: string;
          model?: string;
          epic?: boolean;
          autoMerge?: boolean;
        }
      ) => {
        try {
          // Parse the issue ID
          const parsed = parseIssueId(issueId);
          if (!parsed) {
            console.error(
              "Error: Invalid issue ID format. Expected: <draft-id>/<issue-number> or <draft-id>:<issue-number>"
            );
            console.error("");
            console.error("Examples:");
            console.error("  propr implement-issue abc123/1");
            console.error("  propr implement-issue draft-uuid-here:42");
            process.exit(1);
          }

          const { draftId, issueNumber } = parsed;

          console.log(`Implementing issue #${issueNumber} from draft ${draftId}...`);

          // Trigger the implementation
          const result = await implementIssue(draftId, issueNumber, {
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

          // If a task ID was returned, show it
          if (result.taskId) {
            console.log(`Task ID: ${result.taskId}`);
          }

          // If --wait flag is not set, exit here
          if (!options.wait) {
            if (result.taskId) {
              console.log("");
              console.log(
                "Use 'propr implement-issue <issue-id> --wait' to wait for completion."
              );
            }
            return;
          }

          // If no task ID was returned, we can't poll
          if (!result.taskId) {
            console.log("");
            console.log(
              "Note: No task ID returned. The implementation may be triggered asynchronously."
            );
            return;
          }

          // Poll for completion
          console.log("");
          console.log("Waiting for implementation to complete...");

          const finalStatus = await pollTaskStatus(result.taskId);

          // Print final result
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
            // Timeout or unknown state
            console.log(
              `Implementation is still ${formatState(finalStatus.currentState)} after ${Math.round((Date.now() - Date.now()) / 1000)} seconds.`
            );
            console.log(`Task ID: ${result.taskId}`);
            console.log("You can check the status later using the ProPR dashboard.");
          }
        } catch (error) {
          if (error instanceof ProjectResolutionError) {
            console.error(`Error: ${error.message}`);
            process.exit(1);
          }
          console.error(
            `Error implementing issue: ${(error as Error).message}`
          );
          process.exit(1);
        }
      }
    );
}
