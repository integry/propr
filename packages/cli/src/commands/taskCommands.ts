/**
 * Task Management Commands
 *
 * CLI commands for managing tasks using the ProPR backend.
 * Provides the `task` command group with `list`, `get`, `stop`, `delete`, and `revert` subcommands.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { resolveProject, ProjectResolutionError, normalizeProjectSlug, printOutput } from "../utils/index.js";
import {
  listTasks,
  stopTask,
  deleteTask,
  followupTask,
  importTasks,
  getRevertPreview,
  revertTask,
  TaskSummary,
  getTaskStatus,
  TaskStatus,
} from "../api/index.js";

/**
 * Formats a task status for display.
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
 */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleString();
}

/**
 * Truncates a string to a maximum length.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

export function resolveFollowupBodyArgument(bodyArg: string[] | undefined): string | undefined {
  return bodyArg?.join(" ");
}

export type BodySource = "argument" | "file" | "stdin" | "none";

/**
 * Picks the single text source for a command that accepts a positional
 * argument, --file, and --stdin, and rejects conflicting combinations so no
 * input is silently discarded.
 */
export function selectBodySource(sources: {
  argument?: string;
  file?: string;
  stdin?: boolean;
}): BodySource {
  const provided: BodySource[] = [];
  if (sources.argument !== undefined && sources.argument.length > 0) provided.push("argument");
  if (sources.file) provided.push("file");
  if (sources.stdin) provided.push("stdin");
  if (provided.length > 1) {
    throw new Error(
      `Provide the text via only one of: argument, --file, or --stdin (got ${provided.join(" and ")}).`
    );
  }
  return provided[0] ?? "none";
}

/**
 * Resolves command text from a variadic positional argument, --file, or
 * --stdin. Stdin is read only when --stdin is given explicitly, so commands
 * never block on an inherited-but-silent stdin pipe (cron, CI).
 */
async function resolveTextInput(
  positional: string[] | undefined,
  options: { file?: string; stdin?: boolean }
): Promise<string | undefined> {
  const argument = resolveFollowupBodyArgument(positional);
  const source = selectBodySource({ argument, file: options.file, stdin: options.stdin });
  switch (source) {
    case "file": {
      const { readFile } = await import("node:fs/promises");
      return (await readFile(options.file!, "utf8")).trim();
    }
    case "stdin":
      return readStdinBody();
    case "argument":
      return argument;
    default:
      return undefined;
  }
}

/**
 * Displays a table of tasks with clean formatting.
 */
function displayTasksTable(tasks: TaskSummary[]): void {
  const idWidth = Math.max(
    "ID".length,
    ...tasks.map((t) => t.id.length)
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

  const header = [
    "ID".padEnd(idWidth),
    "Repository".padEnd(repoWidth),
    "Issue".padEnd(issueWidth),
    "Status".padEnd(statusWidth),
    "Title".padEnd(titleWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const task of tasks) {
    const row = [
      task.id.padEnd(idWidth),
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
}

function displayRevertPreview(preview: Awaited<ReturnType<typeof getRevertPreview>>): void {
  console.log("");
  console.log("Revert preview");
  console.log("=".repeat(50));
  console.log(`Branch:       ${preview.branch}`);
  console.log(`Base branch:  ${preview.baseBranch}`);
  console.log(`Target:       ${preview.targetCommit.shortSha ?? preview.targetCommit.sha}`);
  console.log(`New head:     ${preview.newHead ? (preview.newHead.shortSha ?? preview.newHead.sha) : "(base branch)"}`);
  console.log(`Revert base:  ${preview.willRevertToBase ? "yes" : "no"}`);
  console.log("");
  console.log(`Commits to remove (${preview.commitsToRemove.length}):`);
  for (const commit of preview.commitsToRemove) {
    const shortSha = commit.shortSha ?? commit.sha.substring(0, 7);
    console.log(`  - ${shortSha}${commit.message ? ` ${commit.message}` : ""}`);
  }
  console.log("");
  console.log(`Commits remaining (${preview.remainingCommits.length}):`);
  if (preview.remainingCommits.length === 0) {
    console.log("  (none)");
  } else {
    for (const commit of preview.remainingCommits) {
      const shortSha = commit.shortSha ?? commit.sha.substring(0, 7);
      console.log(`  - ${shortSha}${commit.message ? ` ${commit.message}` : ""}`);
    }
  }
}

async function readStdinBody(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--stdin was given but stdin is a terminal. Pipe the text in, or use an argument or --file."
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  return input || undefined;
}

/**
 * Prompts the user for confirmation.
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
 * Creates the `task` command group.
 */
export function createTaskCommand(): Command {
  const task = new Command("task")
    .description("Manage implementation tasks")
    .addHelpText("after", `
Examples:
  $ propr task list                              # List all tasks
  $ propr task list -s processing                # Filter by status
  $ propr task get abc123                        # View task details
  $ propr task stop abc123                       # Stop a running task
  $ propr task delete abc123                     # Delete a task
  $ propr task revert myorg/myrepo 123 abc 456   # Revert a commit
`);

  // task list
  task
    .command("list")
    .description("List tasks with optional filtering by project, status, or search term")
    .option("-p, --project <project>", "Filter by project (owner/repo)")
    .option(
      "-s, --status <status>",
      "Filter by status (pending, queued, processing, completed, failed, cancelled, or all)",
      "all"
    )
    .option("-l, --limit <limit>", "Maximum number of tasks to show", "50")
    .option("--search <term>", "Search tasks by term")
    .option("-j, --json", "Output as JSON for programmatic use")
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
  $ propr task list                           # List all tasks
  $ propr task list -p myorg/myrepo           # Filter by project
  $ propr task list -s processing             # Filter by status
  $ propr task list --search "auth" -l 100    # Search with limit
  $ propr task list --json                    # JSON output
`)
    .action(
      async (options: {
        project?: string;
        status: string;
        limit: string;
        search?: string;
        json?: boolean;
      }) => {
        try {
          const listOptions: {
            status?: string;
            repository?: string;
            limit?: number;
            search?: string;
          } = {};

          if (options.status && options.status !== "all") {
            listOptions.status = options.status.toLowerCase();
          }

          if (options.project) {
            listOptions.repository = options.project;
          }

          const limit = parseInt(options.limit, 10);
          if (!isNaN(limit) && limit > 0) {
            listOptions.limit = limit;
          }

          if (options.search) {
            listOptions.search = options.search;
          }

          const result = await listTasks(listOptions);

          if (printOutput(result, options.json ?? false)) {
            return;
          }

          console.log("Fetching tasks...");

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

  // task get
  task
    .command("get <task-id>")
    .description("Get detailed information about a specific task including history and metadata")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  task-id    The unique identifier of the task

Examples:
  $ propr task get abc123-task-id
  $ propr task get abc123-task-id --json
`)
    .action(async (taskId: string, options: { json?: boolean }) => {
      try {
        const status = await getTaskStatus(taskId);

        if (printOutput(status, options.json ?? false)) {
          return;
        }

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

  // task stop
  task
    .command("stop <task-id>")
    .description("Stop a running task (only works for active tasks)")
    .addHelpText("after", `
Argument:
  task-id    The unique identifier of the task to stop

Note:
  This command only works for tasks in active states (pending, queued, processing).
  Tasks in terminal states (completed, failed, cancelled) cannot be stopped.

Example:
  $ propr task stop abc123-task-id
`)
    .action(async (taskId: string) => {
      try {
        let currentStatus: string | undefined;
        try {
          const status = await getTaskStatus(taskId);
          currentStatus = status.currentState;

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

  // task delete
  task
    .command("delete <task-id>")
    .description("Delete a task from the system permanently")
    .option("-f, --force", "Force deletion even for active tasks")
    .addHelpText("after", `
Argument:
  task-id    The unique identifier of the task to delete

Note:
  Active tasks require --force flag to delete.
  Consider using 'propr task stop' first for running tasks.

Examples:
  $ propr task delete abc123-task-id           # With confirmation
  $ propr task delete abc123-task-id --force   # Force delete active task
`)
    .action(async (taskId: string, options: { force?: boolean }) => {
      try {
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
                "Alternatively, stop the task first with 'propr task stop'."
              );
              console.log("");
            }
          }
        } catch {
          console.log(`Task ID: ${taskId}`);
          console.log("");
        }

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

  // task followup
  task
    .command("followup <task-id> [body...]")
    .description("Post and queue a follow-up instruction for a task")
    .option("-f, --file <path>", "Read follow-up body from a file")
    .option("--stdin", "Read follow-up body from standard input")
    .addHelpText("after", `
The body must come from exactly one source: the argument, --file, or --stdin.

Examples:
  $ propr task followup abc123 Please also add tests
  $ propr task followup abc123 --file followup.md
  $ echo "Address the review comments" | propr task followup abc123 --stdin
`)
    .action(async (taskId: string, bodyArg: string[] | undefined, options: { file?: string; stdin?: boolean }) => {
      try {
        const body = await resolveTextInput(bodyArg, options);
        if (!body || body.trim().length === 0) {
          console.error("Error: Follow-up body is required via an argument, --file, or --stdin.");
          process.exit(1);
        }

        const result = await followupTask(taskId, body.trim());
        console.log(result.message);
        console.log(`Comment ID: ${result.commentId}`);
        console.log(`Job ID: ${result.jobId}`);
      } catch (error) {
        console.error(`Error posting follow-up: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // task import
  task
    .command("import [description...]")
    .description("Reconcile or recover tasks from GitHub for a repository")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-f, --file <path>", "Read import description from a file")
    .option("--stdin", "Read import description from standard input")
    .addHelpText("after", `
The description must come from at most one source: the argument, --file, or
--stdin. When omitted, a default reconcile description is used.

Examples:
  $ propr task import -p myorg/myrepo Recover missing GitHub tasks
  $ propr task import --file import.md
  $ echo "Recover missing GitHub tasks" | propr task import --stdin
`)
    .action(async (descriptionArg: string[] | undefined, options: { project?: string; file?: string; stdin?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const rawProject = resolveProject(options, configManager);
        const project = normalizeProjectSlug(rawProject);
        if (project === null) {
          throw new ProjectResolutionError(
            `Invalid project "${rawProject}". Expected owner/repo format.`
          );
        }
        const taskDescription =
          (await resolveTextInput(descriptionArg, options)) ?? "Reconcile and recover tasks from GitHub";
        const result = await importTasks(project, taskDescription);
        console.log(`Task import queued for ${project}.`);
        console.log(`Job ID: ${result.jobId}`);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Error importing tasks: ${(error as Error).message}`);
        }
        process.exit(1);
      }
    });

  // task revert
  task
    .command("revert <repo> <pr> <commit> [commentId]")
    .description("Revert changes from a specific commit in a pull request")
    .option("-o, --owner <owner>", "Repository owner (required if repo is not in owner/repo format)")
    .option("--dry-run", "Preview the branch reset without queueing a revert task")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Arguments:
  repo         Repository name (owner/repo format) or just repo name with -o flag
  pr           Pull request number
  commit       Commit hash to revert
  commentId    ID of the comment that triggered the revert (not required and ignored with --dry-run)

Examples:
  $ propr task revert myorg/myrepo 123 abc123def 456789
  $ propr task revert myorg/myrepo 123 abc123def --dry-run
  $ propr task revert myrepo 123 abc123def 456789 -o myorg
`)
    .action(
      async (
        repo: string,
        pr: string,
        commit: string,
        commentId: string | undefined,
        options: { owner?: string; dryRun?: boolean; json?: boolean }
      ) => {
        try {
          let owner = options.owner;
          let repoName = repo;

          if (repo.includes("/")) {
            const parts = repo.split("/");
            if (parts.length === 2) {
              owner = owner || parts[0];
              repoName = parts[1];
            }
          }

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
          const commentIdNum = commentId ? parseInt(commentId, 10) : NaN;

          if (isNaN(prNumber) || prNumber <= 0) {
            console.error("Error: PR number must be a positive integer");
            process.exit(1);
          }

          if (!options.dryRun && (isNaN(commentIdNum) || commentIdNum <= 0)) {
            console.error("Error: Comment ID must be a positive integer");
            process.exit(1);
          }

          if (!commit || commit.trim().length === 0) {
            console.error("Error: Commit hash is required");
            process.exit(1);
          }

          if (options.dryRun) {
            if (commentId !== undefined) {
              console.warn("Note: commentId is ignored with --dry-run; no revert task is queued.");
            }
            const preview = await getRevertPreview(owner, repoName, prNumber, commit);
            if (printOutput(preview, options.json ?? false)) {
              return;
            }
            displayRevertPreview(preview);
            return;
          }

          const result = await revertTask(owner, repoName, prNumber, commit, commentIdNum);

          if (result.success && printOutput(result, options.json ?? false)) {
            return;
          }

          if (result.success) {
            console.log("");
            console.log("Revert task queued successfully!");
            console.log(`Job ID: ${result.jobId}`);
            console.log(`Correlation ID: ${result.correlationId}`);
            console.log(`Message: ${result.message}`);
            console.log("");
            console.log("You can check the status of this task with:");
            console.log(`  propr task list -p ${owner}/${repoName}`);
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

  return task;
}
