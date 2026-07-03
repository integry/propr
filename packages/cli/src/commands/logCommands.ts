/**
 * LLM Log Management Commands
 *
 * CLI commands for viewing LLM execution logs.
 * Provides the `log` command group with the `list` subcommand.
 */

import { Command } from "commander";
import { listLlmLogs, LlmLogEntry, UnauthorizedError, NetworkError } from "../api/index.js";
import { printOutput } from "../utils/index.js";

/**
 * Truncates a string to a maximum length.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "-";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Formats a number with commas for readability.
 */
function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return "-";
  return num.toLocaleString();
}

/**
 * Formats tokens count (input + output).
 */
function formatTokens(
  input: number | null | undefined,
  output: number | null | undefined
): string {
  const inputStr = input !== null && input !== undefined ? formatNumber(input) : "-";
  const outputStr = output !== null && output !== undefined ? formatNumber(output) : "-";

  if (inputStr === "-" && outputStr === "-") {
    return "-";
  }

  return `${inputStr}/${outputStr}`;
}

/**
 * Formats cost in USD.
 */
function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "-";
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Displays a table of LLM logs with clean formatting.
 */
function displayLogsTable(logs: LlmLogEntry[]): void {
  if (logs.length === 0) {
    console.log("No logs found.");
    return;
  }

  const typeWidth = Math.max(
    "Type".length,
    ...logs.map((l) => truncate(l.executionType, 15).length)
  );
  const modelWidth = Math.max(
    "Model".length,
    ...logs.map((l) => truncate(l.modelName, 25).length)
  );
  const tokensWidth = Math.max(
    "Tokens (In/Out)".length,
    ...logs.map((l) => formatTokens(l.inputTokens, l.outputTokens).length)
  );
  const costWidth = Math.max(
    "Cost".length,
    ...logs.map((l) => formatCost(l.costUsd).length)
  );

  const header = [
    "Type".padEnd(typeWidth),
    "Model".padEnd(modelWidth),
    "Tokens (In/Out)".padEnd(tokensWidth),
    "Cost".padEnd(costWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const log of logs) {
    const row = [
      truncate(log.executionType, 15).padEnd(typeWidth),
      truncate(log.modelName, 25).padEnd(modelWidth),
      formatTokens(log.inputTokens, log.outputTokens).padEnd(tokensWidth),
      formatCost(log.costUsd).padEnd(costWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Creates the `log` command group.
 */
export function createLogCommand(): Command {
  const log = new Command("log")
    .description("View LLM execution logs")
    .addHelpText("after", `
Examples:
  $ propr log list                      # List recent logs
  $ propr log list -m claude-sonnet-4-20250514  # Filter by model
  $ propr log list --failed             # Show failures only
`);

  // log list
  log
    .command("list")
    .description("List LLM execution logs for auditing, debugging, and cost analysis")
    .option("-l, --limit <limit>", "Maximum number of logs to show", "50")
    .option("-m, --model <model>", "Filter by model name")
    .option("-t, --type <type>", "Filter by execution type")
    .option("--page <page>", "Page number for pagination", "1")
    .option("--success", "Show only successful executions")
    .option("--failed", "Show only failed executions")
    .option("--agent <alias>", "Filter by agent alias")
    .option("--draft <draftId>", "Filter by draft/plan ID")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr log list                            # List recent logs
  $ propr log list -l 100 --page 2            # Paginated results
  $ propr log list -m claude-sonnet-4-20250514            # Filter by model
  $ propr log list --failed                   # Show failures only
  $ propr log list --draft abc123             # Filter by plan ID
  $ propr log list --agent my-claude          # Filter by agent
  $ propr log list --json                     # JSON output
`)
    .action(
      async (options: {
        limit: string;
        model?: string;
        type?: string;
        page: string;
        success?: boolean;
        failed?: boolean;
        agent?: string;
        draft?: string;
        json?: boolean;
      }) => {
        try {
          const listOptions: {
            limit?: number;
            model?: string;
            executionType?: string;
            page?: number;
            success?: boolean;
            agentAlias?: string;
            draftId?: string;
          } = {};

          const limit = parseInt(options.limit, 10);
          if (!isNaN(limit) && limit > 0) {
            listOptions.limit = Math.min(limit, 100);
          }

          const page = parseInt(options.page, 10);
          if (!isNaN(page) && page > 0) {
            listOptions.page = page;
          }

          if (options.model) {
            listOptions.model = options.model;
          }

          if (options.type) {
            listOptions.executionType = options.type;
          }

          if (options.success) {
            listOptions.success = true;
          } else if (options.failed) {
            listOptions.success = false;
          }

          if (options.agent) {
            listOptions.agentAlias = options.agent;
          }

          if (options.draft) {
            listOptions.draftId = options.draft;
          }

          const result = await listLlmLogs(listOptions);

          if (printOutput(result, options.json ?? false)) {
            return;
          }

          console.log("Fetching LLM logs...");

          console.log("");
          displayLogsTable(result.logs);

          console.log("");
          console.log(
            `Showing ${result.logs.length} of ${result.pagination.total} log(s) (page ${result.pagination.page}/${result.pagination.totalPages})`
          );

          if (result.pagination.hasNextPage) {
            console.log(
              `Use --page ${result.pagination.page + 1} to see more results`
            );
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (
            error instanceof UnauthorizedError ||
            errorMessage.includes("401") ||
            errorMessage.toLowerCase().includes("unauthorized")
          ) {
            console.error(
              "Error: Unauthorized. Please run 'propr login' first."
            );
          } else {
            console.error(`Error listing logs: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  return log;
}
