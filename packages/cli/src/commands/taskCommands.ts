/**
 * Task Management Commands
 *
 * CLI commands for managing tasks using the ProPR backend.
 * Provides the `list-tasks`, `get-task`, `stop-task`, and `delete-task` commands.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { resolveProject, ProjectResolutionError } from "../utils/index.js";
import {
  listTasks,
  stopTask,
  deleteTask,
  revertTask,
  TaskSummary,
  getTaskStatus,
  TaskStatus,
} from "../api/index.js";

/**
 * Formats a task status for display.
 *
 * @param status - The task status.
 * @returns A formatted status string.
 */
function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    pending: "Pending",
    queued: "Queued",
    processing: "Processing",
    claude_execution: "Executing",
    post_processing: "Post-processing",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return statusMap[status?.toLowerCase()] || status;
}

/**
 * Formats a date string for display.
 *
 * @param dateStr - The ISO date string.
 * @returns A formatted date string or "-" if null.
 */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleString();
}

/**
 * Truncates a string to a maximum length.
 *
 * @param str - The string to truncate.
 * @param maxLen - The maximum length.
 * @returns The truncated string with "..." if it was too long.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Displays a table of tasks with clean formatting.
 *
 * @param tasks - The tasks to display.
 */
function displayTasksTable(tasks: TaskSummary[]): void {
  // Calculate column widths
  const idWidth = Math.max(
    "ID".length,
    ...tasks.map((t) => truncate(t.id, 12).length)
  );
  const repoWidth = Math.max(
    "Repository".length,
    ...tasks.map((t) => truncate(t.repository, 25).length)
  );
  const issueWidth = Math.max(
    "Issue".length,
    ...tasks.map((t) => String(t.issueNumber || "-").length)
  );
  const statusWidth = Math.max(
    "Status".length,
    ...tasks.map((t) => formatStatus(t.status).length)
  );
  const titleWidth = Math.max(
    "Title".length,
    ...tasks.map((t) => truncate(t.title, 30).length)
  );

  // Print header
  const header = [
    "ID".padEnd(idWidth),
    "Repository".padEnd(repoWidth),
    "Issue".padEnd(issueWidth),
    "Status".padEnd(statusWidth),
    "Title".padEnd(titleWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  // Print each task
  for (const task of tasks) {
    const row = [
      truncate(task.id, 12).padEnd(idWidth),
      truncate(task.repository, 25).padEnd(repoWidth),
      String(task.issueNumber || "-").padEnd(issueWidth),
      formatStatus(task.status).padEnd(statusWidth),
      truncate(task.title, 30).padEnd(titleWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Displays detailed task information from TaskStatus.
 *
 * @param status - The task status to display.
 */
function displayTaskDetails(status: TaskStatus): void {
  console.log("");
  console.log("=".repeat(60));
  console.log("Task Details");
  console.log("=".repeat(60));
  console.log("");

  console.log(`ID:           ${status.taskId}`);
  console.log(`Status:       ${formatStatus(status.currentState)}`);

  if (status.taskInfo) {
    const info = status.taskInfo;
    console.log(`Repository:   ${info.repoOwner}/${info.repoName}`);
    console.log(`Type:         ${info.type}`);
    console.log(`Number:       #${info.number}`);

    if (info.title) {
      console.log(`Title:        ${info.title}`);
    }
    if (info.subtitle) {
      console.log(`Subtitle:     ${info.subtitle}`);
    }
    if (info.modelName) {
      console.log(`Model:        ${info.modelName}`);
    }
    if (info.correlationId) {
      console.log(`Correlation:  ${info.correlationId}`);
    }
    if (info.issueNumber && info.issueNumber !== info.number) {
      console.log(`Linked Issue: #${info.issueNumber}`);
    }
  }

  if (status.prNumber) {
    console.log(`PR Number:    #${status.prNumber}`);
  }
  if (status.prUrl) {
    console.log(`PR URL:       ${status.prUrl}`);
  }

  if (status.isFailed && status.failureReason) {
    console.log("");
    console.log("Failure Reason:");
    console.log("-".repeat(40));
    console.log(status.failureReason);
  }

  // Display history
  if (status.history && status.history.length > 0) {
    console.log("");
    console.log("History:");
    console.log("-".repeat(40));

    for (const entry of status.history) {
      const timestamp = new Date(entry.timestamp).toLocaleString();
      let line = `[${timestamp}] ${formatStatus(entry.state)}`;

      if (entry.message) {
        line += ` - ${entry.message}`;
      }
      if (entry.reason) {
        line += ` (${entry.reason})`;
      }

      console.log(line);

      // Show metadata details if present
      if (entry.metadata) {
        if (entry.metadata.model) {
          console.log(`  Model: ${entry.metadata.model}`);
        }
        if (entry.metadata.duration !== undefined) {
          console.log(`  Duration: ${entry.metadata.duration}ms`);
        }
        if (entry.metadata.tokenUsage) {
          const usage = entry.metadata.tokenUsage;
          const parts: string[] = [];
          if (usage.input_tokens) parts.push(`input: ${usage.input_tokens}`);
          if (usage.output_tokens) parts.push(`output: ${usage.output_tokens}`);
          if (parts.length > 0) {
            console.log(`  Tokens: ${parts.join(", ")}`);
          }
        }
      }
    }
  }

  console.log("");
  console.log("=".repeat(60));

  // Print full JSON for debugging
  console.log("");
  console.log("Full JSON:");
  console.log("-".repeat(40));
  console.log(JSON.stringify(status, null, 2));
}

/**
 * Prompts the user for confirmation.
 *
 * @param message - The confirmation message.
 * @returns A promise resolving to true if confirmed, false otherwise.
 */
async function confirm(message: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Registers task management commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerTaskCommands(program: Command): void {
  // List tasks command
  program
    .command("list-tasks")
    .description("List tasks with optional filtering by project, status, or search term")
    .option("-p, --project <project>", "Filter by project (owner/repo)")
    .option(
      "-s, --status <status>",
      "Filter by status (pending, queued, processing, completed, failed, cancelled, or all)",
      "all"
    )
    .option("-l, --limit <limit>", "Maximum number of tasks to show", "50")
    .option("--search <term>", "Search tasks by term")
    .addHelpText("after", `
Status Values:
  pending      Task waiting to be queued
  queued       Task in queue waiting for worker
  processing   Task being executed
  completed    Task finished successfully
  failed       Task failed with error
  cancelled    Task was cancelled
  all          Show all tasks (default)

Examples:
  $ propr list-tasks                           # List all tasks
  $ propr list-tasks -p myorg/myrepo           # Filter by project
  $ propr list-tasks -s processing             # Filter by status
  $ propr list-tasks --search "auth" -l 100    # Search with limit
`)
    .action(
      async (options: {
        project?: string;
        status: string;
        limit: string;
        search?: string;
      }) => {
        try {
          const listOptions: {
            status?: string;
            repository?: string;
            limit?: number;
            search?: string;
          } = {};

          // Handle status filter
          if (options.status && options.status !== "all") {
            listOptions.status = options.status.toLowerCase();
          }

          // Handle project filter
          if (options.project) {
            listOptions.repository = options.project;
          }

          // Handle limit
          const limit = parseInt(options.limit, 10);
          if (!isNaN(limit) && limit > 0) {
            listOptions.limit = limit;
          }

          // Handle search
          if (options.search) {
            listOptions.search = options.search;
          }

          console.log("Fetching tasks...");

          const result = await listTasks(listOptions);

          if (result.tasks.length === 0) {
            console.log("");
            console.log("No tasks found.");
            if (options.project) {
              console.log(`Project filter: ${options.project}`);
            }
            if (options.status !== "all") {
              console.log(`Status filter: ${options.status}`);
            }
            return;
          }

          console.log("");
          displayTasksTable(result.tasks);

          console.log("");
          console.log(`Showing ${result.tasks.length} of ${result.total} task(s)`);

          if (result.tasks.length < result.total) {
            console.log(
              `Use --limit to show more (currently showing ${result.limit})`
            );
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error(
              "Error: Unauthorized. Please run 'propr login' first."
            );
          } else {
            console.error(`Error listing tasks: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  // Get task command
  program
    .command("get-task <task-id>")
    .description("Get detailed information about a specific task including history and metadata")
    .addHelpText("after", `
Argument:
  task-id    The unique identifier of the task

Output includes:
  - Task status and progress
  - Repository and issue information
  - PR number/URL if created
  - Full history with timestamps
  - Token usage statistics

Example:
  $ propr get-task abc123-task-id
`)
    .action(async (taskId: string) => {
      try {
        console.log(`Fetching task ${taskId}...`);

        const status = await getTaskStatus(taskId);
        displayTaskDetails(status);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Task not found: ${taskId}`);
        } else if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to view this task."
          );
        } else {
          console.error(`Error fetching task: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Stop task command
  program
    .command("stop-task <task-id>")
    .description("Stop a running task (only works for active tasks)")
    .addHelpText("after", `
Argument:
  task-id    The unique identifier of the task to stop

Note:
  This command only works for tasks in active states (pending, queued, processing).
  Tasks in terminal states (completed, failed, cancelled) cannot be stopped.

Example:
  $ propr stop-task abc123-task-id
`)
    .action(async (taskId: string) => {
      try {
        // First, check the task status
        let currentStatus: string | undefined;
        try {
          const status = await getTaskStatus(taskId);
          currentStatus = status.currentState;

          // Check if task is in a terminal state
          const terminalStates = ["completed", "failed", "cancelled"];
          if (terminalStates.includes(currentStatus.toLowerCase())) {
            console.log(`Task is already in "${formatStatus(currentStatus)}" state.`);
            console.log("No action needed.");
            return;
          }

          console.log(`Current status: ${formatStatus(currentStatus)}`);
        } catch {
          // If we can't fetch the status, continue with stop attempt
        }

        console.log(`Stopping task ${taskId}...`);

        const result = await stopTask(taskId);

        if (result.success) {
          console.log(result.message || "Task stopped successfully.");
        } else {
          console.error(`Failed to stop task: ${result.message}`);
          process.exit(1);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Task not found: ${taskId}`);
        } else if (errorMessage.includes("400")) {
          console.error(
            "Error: Task cannot be stopped in its current state."
          );
        } else if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to stop this task."
          );
        } else {
          console.error(`Error stopping task: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Delete task command
  program
    .command("delete-task <task-id>")
    .description("Delete a task from the system permanently")
    .option("-f, --force", "Force deletion even for active tasks")
    .addHelpText("after", `
Argument:
  task-id    The unique identifier of the task to delete

Note:
  Active tasks require --force flag to delete.
  Consider using 'stop-task' first for running tasks.

Examples:
  $ propr delete-task abc123-task-id           # With confirmation
  $ propr delete-task abc123-task-id --force   # Force delete active task
`)
    .action(async (taskId: string, options: { force?: boolean }) => {
      try {
        // Fetch the task first to show what will be deleted
        let taskInfo: string = taskId;
        let currentStatus: string | undefined;
        try {
          const status = await getTaskStatus(taskId);
          currentStatus = status.currentState;

          if (status.taskInfo) {
            const info = status.taskInfo;
            taskInfo = `${info.repoOwner}/${info.repoName}#${info.number}`;
            if (info.title) {
              taskInfo += ` - ${info.title}`;
            }
          }

          console.log(`Task: ${taskInfo}`);
          console.log(`Status: ${formatStatus(currentStatus)}`);
          console.log("");

          // Warn if task is active
          const activeStates = [
            "pending",
            "queued",
            "processing",
            "claude_execution",
            "post_processing",
          ];
          if (activeStates.includes(currentStatus.toLowerCase())) {
            if (!options.force) {
              console.log(
                "Warning: This task is currently active. Use --force to delete anyway."
              );
              console.log(
                "Alternatively, stop the task first with 'propr stop-task'."
              );
              console.log("");
            }
          }
        } catch {
          // If we can't fetch the task, continue with deletion using just the ID
          console.log(`Task ID: ${taskId}`);
          console.log("");
        }

        // Confirm deletion unless --force is used
        if (!options.force) {
          const confirmed = await confirm(
            "Are you sure you want to delete this task?"
          );
          if (!confirmed) {
            console.log("Deletion cancelled.");
            return;
          }
        }

        console.log(`Deleting task ${taskId}...`);
        await deleteTask(taskId, options.force || false);
        console.log("Task deleted successfully.");
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Task not found: ${taskId}`);
        } else if (errorMessage.includes("400")) {
          console.error(
            "Error: Cannot delete task in active state. Stop the task first or use --force."
          );
        } else if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to delete this task."
          );
        } else {
          console.error(`Error deleting task: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Revert task command
  program
    .command("revert-task <repo> <pr> <commit> <commentId>")
    .description("Revert changes from a specific commit in a pull request")
    .option("-o, --owner <owner>", "Repository owner (required if repo is not in owner/repo format)")
    .addHelpText("after", `
Arguments:
  repo         Repository name (owner/repo format) or just repo name with -o flag
  pr           Pull request number
  commit       Commit hash to revert
  commentId    ID of the comment that triggered the revert

Examples:
  $ propr revert-task myorg/myrepo 123 abc123def 456789
  $ propr revert-task myrepo 123 abc123def 456789 -o myorg
`)
    .action(
      async (
        repo: string,
        pr: string,
        commit: string,
        commentId: string,
        options: { owner?: string }
      ) => {
        try {
          // Determine owner and repo name
          let owner = options.owner;
          let repoName = repo;

          // Check if repo is in owner/repo format
          if (repo.includes("/")) {
            const parts = repo.split("/");
            if (parts.length === 2) {
              owner = owner || parts[0];
              repoName = parts[1];
            }
          }

          // If owner is still not set, try to get from config
          if (!owner) {
            const configManager = await createConfigManager();
            const defaultProject = configManager.getDefaultProject();
            if (defaultProject && defaultProject.includes("/")) {
              owner = defaultProject.split("/")[0];
            }
          }

          if (!owner) {
            console.error(
              "Error: Owner must be provided via --owner flag, in repo argument as owner/repo, or in propr config"
            );
            process.exit(1);
          }

          const prNumber = parseInt(pr, 10);
          const commentIdNum = parseInt(commentId, 10);

          if (isNaN(prNumber) || prNumber <= 0) {
            console.error("Error: PR number must be a positive integer");
            process.exit(1);
          }

          if (isNaN(commentIdNum) || commentIdNum <= 0) {
            console.error("Error: Comment ID must be a positive integer");
            process.exit(1);
          }

          if (!commit || commit.trim().length === 0) {
            console.error("Error: Commit hash is required");
            process.exit(1);
          }

          console.log(
            `Reverting commit ${commit} from PR #${pr} in ${owner}/${repoName}...`
          );

          const result = await revertTask(owner, repoName, prNumber, commit, commentIdNum);

          if (result.success) {
            console.log("");
            console.log("Revert task queued successfully!");
            console.log(`Job ID: ${result.jobId}`);
            console.log(`Correlation ID: ${result.correlationId}`);
            console.log(`Message: ${result.message}`);
            console.log("");
            console.log("You can check the status of this task with:");
            console.log(`  propr list-tasks -p ${owner}/${repoName}`);
          } else {
            console.error(`Failed to queue revert task: ${result.message}`);
            process.exit(1);
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error("Error: Unauthorized. Please run 'propr login' first.");
          } else if (
            errorMessage.includes("403") ||
            errorMessage.includes("forbidden")
          ) {
            console.error(
              "Error: Access denied. You do not have permission to revert this PR."
            );
          } else if (
            errorMessage.includes("404") ||
            errorMessage.includes("not found")
          ) {
            console.error("Error: Repository, PR, or commit not found.");
          } else if (errorMessage.includes("400")) {
            console.error("Error: Invalid parameters provided.");
          } else {
            console.error(`Error reverting task: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );
}
