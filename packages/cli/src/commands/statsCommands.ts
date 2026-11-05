/**
 * Stats Commands
 *
 * Read-only analytics from the ProPR backend. `propr stats review-scores`
 * reports review quality per implementer model.
 */

import { Command, Option } from "commander";
import { ANALYTICS_TIMEFRAMES } from "@propr/shared";
import { getReviewScoreSummary, type ReviewScoreModelSummary, type ReviewScoreSummary } from "../api/index.js";
import { printOutput } from "../utils/index.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

const UNKNOWN = "—";

const figure = (value: number | null, n: number, format: (value: number) => string = String): string =>
  value === null ? `${UNKNOWN} (n=${n})` : `${format(value)} (n=${n})`;

/** One row per implementer model; every figure shows its denominator. */
export function formatReviewScoreRows(summary: ReviewScoreSummary): string[][] {
  return summary.models.map((model: ReviewScoreModelSummary) => [
    model.implementer_model ?? "(unknown)",
    String(model.prs_scored),
    figure(model.first_score.mean, model.first_score.n),
    figure(model.first_score.median, model.first_score.n),
    figure(model.final_score.mean, model.final_score.n),
    figure(model.cycles_to_goal.mean, model.cycles_to_goal.n),
    figure(model.merge_rate.value, model.merge_rate.n, value => `${Math.round(value * 100)}%`),
    figure(model.cost_per_merged_pr.usd, model.cost_per_merged_pr.n, value => `$${value.toFixed(2)}`),
  ]);
}

const HEADERS = ["Model", "PRs", "First mean", "First median", "Final mean", "Cycles to goal", "Merge rate", "Cost/merged PR"];

function displayReviewScores(summary: ReviewScoreSummary): void {
  console.log("");
  console.log(`Review quality by model · ${summary.period ?? "all time"} · ${summary.repository}`);
  console.log(`${summary.prs_scored} PRs scored from ${summary.scores_recorded} reviews`);
  console.log("");
  if (summary.models.length === 0) {
    console.log("No review scores recorded in this period.");
    return;
  }
  const rows = [HEADERS, ...formatReviewScoreRows(summary)];
  const widths = HEADERS.map((_, column) => Math.max(...rows.map(row => row[column].length)));
  for (const [index, row] of rows.entries()) {
    console.log(row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  "));
    if (index === 0) console.log(widths.map(width => "-".repeat(width)).join("  "));
  }
  console.log("");
  console.log("Unknown values show — ; n is the number of pull requests behind each figure.");
}

export function createStatsCommand(): Command {
  const stats = new Command("stats").description("Read ProPR analytics");
  stats.addCommand(new Command("review-scores")
    .description("Review quality per implementer model: scores, cycles to goal, merge rate and cost per merged PR")
    .addOption(new Option("--period <period>", "Timeframe").choices([...ANALYTICS_TIMEFRAMES]))
    .option("--repository <owner/repo>", "Limit to one repository")
    .option("--json", "Output raw JSON response")
    .addHelpText("after", `
Examples:
  $ propr stats review-scores --period 30d
  $ propr stats review-scores --repository acme/app --json
`)
    .action(async (options: { period?: string; repository?: string; json?: boolean }) => {
      try {
        const summary = await getReviewScoreSummary({ period: options.period, repository: options.repository });
        if (printOutput(summary, options.json ?? false)) return;
        displayReviewScores(summary);
      } catch (error) {
        presentApiError(error, {
          forbiddenMessage: "Error: Access denied. You do not have permission to view statistics.",
          fallbackMessage: `Error fetching review score statistics: ${(error as Error).message}`,
        });
        process.exit(1);
      }
    }));
  return stats;
}
