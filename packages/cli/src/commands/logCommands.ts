/**
 * LLM Log Management Commands
 *
 * CLI commands for viewing LLM execution logs.
 * Provides the `list-logs` command for auditing and cost analysis.
 */

import { Command } from "commander";
import { listLlmLogs, LlmLogEntry } from "../api/index.js";

/**
 * Truncates a string to a maximum length.
 *
 * @param str - The string to truncate.
 * @param maxLen - The maximum length.
 * @returns The truncated string with "..." if it was too long.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "-";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Formats a number with commas for readability.
 *
 * @param num - The number to format.
 * @returns Formatted string or "-" if null/undefined.
 */
function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return "-";
  return num.toLocaleString();
}

/**
 * Formats tokens count (input + output).
 *
 * @param input - Input tokens.
 * @param output - Output tokens.
 * @returns Formatted tokens string.
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
 *
 * @param cost - The cost in USD.
 * @returns Formatted cost string.
 */
function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "-";
  // Show cost with appropriate precision
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Displays a table of LLM logs with clean formatting.
 *
 * @param logs - The logs to display.
 */
function displayLogsTable(logs: LlmLogEntry[]): void {
  if (logs.length === 0) {
    console.log("No logs found.");
    return;
  }

  // Calculate column widths
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

  // Print header
  const header = [
    "Type".padEnd(typeWidth),
    "Model".padEnd(modelWidth),
    "Tokens (In/Out)".padEnd(tokensWidth),
    "Cost".padEnd(costWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  // Print each log
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
 * Registers LLM log management commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerLogCommands(program: Command): void {
  // List logs command
  program
    .command("list-logs")
    .description("List LLM execution logs for auditing, debugging, and cost analysis")
    .option("-l, --limit <limit>", "Maximum number of logs to show", "50")
    .option("-m, --model <model>", "Filter by model name")
    .option("-t, --type <type>", "Filter by execution type")
    .option("--page <page>", "Page number for pagination", "1")
    .option("--success", "Show only successful executions")
    .option("--failed", "Show only failed executions")
    .option("--agent <alias>", "Filter by agent alias")
    .option("--draft <draftId>", "Filter by draft/plan ID")
    .addHelpText("after", `
Output includes:
  - Execution type
  - Model name
  - Token usage (input/output)
  - Cost in USD

Examples:
  $ propr list-logs                            # List recent logs
  $ propr list-logs -l 100 --page 2            # Paginated results
  $ propr list-logs -m claude-sonnet-4-20250514            # Filter by model
  $ propr list-logs --failed                   # Show failures only
  $ propr list-logs --draft abc123             # Filter by plan ID
  $ propr list-logs --agent my-claude          # Filter by agent
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

          // Handle limit
          const limit = parseInt(options.limit, 10);
          if (!isNaN(limit) && limit > 0) {
            listOptions.limit = Math.min(limit, 100); // API max is 100
          }

          // Handle page
          const page = parseInt(options.page, 10);
          if (!isNaN(page) && page > 0) {
            listOptions.page = page;
          }

          // Handle model filter
          if (options.model) {
            listOptions.model = options.model;
          }

          // Handle type filter
          if (options.type) {
            listOptions.executionType = options.type;
          }

          // Handle success/failed filters
          if (options.success) {
            listOptions.success = true;
          } else if (options.failed) {
            listOptions.success = false;
          }

          // Handle agent filter
          if (options.agent) {
            listOptions.agentAlias = options.agent;
          }

          // Handle draft filter
          if (options.draft) {
            listOptions.draftId = options.draft;
          }

          console.log("Fetching LLM logs...");

          const result = await listLlmLogs(listOptions);

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
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
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
}
