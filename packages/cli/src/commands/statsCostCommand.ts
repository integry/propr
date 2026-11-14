/**
 * `propr stats cost`: recorded LLM cost grouped by day, repository, agent,
 * model, reasoning level, execution type and outcome.
 */

import { Command, InvalidArgumentError, Option } from "commander";
import { ANALYTICS_TIMEFRAMES } from "@propr/shared";
import { COST_GROUP_KEYS, getCostExport, getCostExportCsv, type CostExport, type CostFigures, type CostGroupKey } from "../api/index.js";
import { printOutput } from "../utils/index.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

const UNKNOWN = "—";

const DIMENSION_HEADERS: Record<CostGroupKey, string> = {
  day: "Day", repository: "Repository", agent: "Agent", model: "Model",
  reasoning_level: "Effort", execution_type: "Type", outcome: "Outcome",
};
const FIGURE_HEADERS = ["Runs", "Tasks", "Input", "Output", "Cache write", "Cache read", "Cost"];

/** Parses `--group-by day,model`; rejects a key the server does not group by. */
export function parseGroupBy(value: string): CostGroupKey[] {
  const keys = value.split(",").map(part => part.trim()).filter(Boolean);
  const unknown = keys.find(key => !(COST_GROUP_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) throw new InvalidArgumentError(`Unknown group "${unknown}". Choose from: ${COST_GROUP_KEYS.join(", ")}.`);
  return keys as CostGroupKey[];
}

const usd = (value: number | null): string => (value === null ? UNKNOWN : `$${value.toFixed(2)}`);

const figureCells = (row: CostFigures): string[] => [
  String(row.executions), String(row.tasks), String(row.input_tokens), String(row.output_tokens),
  String(row.cache_creation_input_tokens), String(row.cache_read_input_tokens), usd(row.cost_usd),
];

/** Header row, then one row per group; unrecorded dimensions and costs show a dash. */
export function formatCostRows(costExport: CostExport): string[][] {
  return [
    [...costExport.group_by.map(key => DIMENSION_HEADERS[key]), ...FIGURE_HEADERS],
    ...costExport.rows.map(row => [...costExport.group_by.map(key => row[key] ?? UNKNOWN), ...figureCells(row)]),
  ];
}

function displayCost(costExport: CostExport): void {
  console.log("");
  console.log(`LLM cost · ${costExport.period ?? "all time"} · ${costExport.repository}`);
  console.log(`${costExport.totals.executions} runs across ${costExport.totals.tasks} tasks · ${usd(costExport.totals.cost_usd)} recorded`);
  console.log("");
  if (costExport.rows.length === 0) {
    console.log("No executions recorded in this period.");
    return;
  }
  const rows = formatCostRows(costExport);
  const dimensions = costExport.group_by.length;
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  for (const [index, row] of rows.entries()) {
    console.log(row.map((cell, column) => (column < dimensions ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  "));
    if (index === 0) console.log(widths.map(width => "-".repeat(width)).join("  "));
  }
  console.log("");
  console.log("Input includes cache reads and writes. Unrecorded values show — .");
}

interface CostOptions { period?: string; repository?: string; groupBy?: CostGroupKey[]; json?: boolean; csv?: boolean }

export function createStatsCostCommand(): Command {
  return new Command("cost")
    .description("Recorded LLM cost by day, repository, agent, model, effort, execution type or outcome")
    .addOption(new Option("--period <period>", "Timeframe").choices([...ANALYTICS_TIMEFRAMES]))
    .option("--repository <owner/repo>", "Limit to one repository")
    .option("--group-by <keys>", `Comma-separated dimensions: ${COST_GROUP_KEYS.join(", ")} (default: day)`, parseGroupBy)
    .addOption(new Option("--json", "Output raw JSON response").conflicts("csv"))
    .addOption(new Option("--csv", "Output CSV, as GET /api/stats/cost.csv returns it").conflicts("json"))
    .addHelpText("after", `
Examples:
  $ propr stats cost --period 30d
  $ propr stats cost --group-by day,model,outcome --csv > cost.csv
  $ propr stats cost --repository acme/app --group-by model,reasoning_level --json
`)
    .action(async (options: CostOptions) => {
      const query = { period: options.period, repository: options.repository, groupBy: options.groupBy };
      try {
        if (options.csv) {
          process.stdout.write(await getCostExportCsv(query));
          return;
        }
        const costExport = await getCostExport(query);
        if (printOutput(costExport, options.json ?? false)) return;
        displayCost(costExport);
      } catch (error) {
        presentApiError(error, {
          forbiddenMessage: "Error: Access denied. You do not have permission to view statistics.",
          fallbackMessage: `Error fetching cost statistics: ${(error as Error).message}`,
        });
        process.exit(1);
      }
    });
}
