import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatsCommand, formatReviewScoreRows } from "./statsCommands.js";

test("review score rows show every figure with its denominator and unknowns as a dash", () => {
  const rows = formatReviewScoreRows({
    period: "30d", repository: "all", prs_scored: 2, scores_recorded: 3,
    models: [
      {
        implementer_model: "claude-opus-5-5", implementer_agent: "claude", prs_scored: 2,
        first_score: { mean: 5.5, median: 5.5, n: 2 }, final_score: { mean: 8, n: 2 },
        cycles_to_goal: { mean: 2, n: 1, attempted: 1 }, merge_rate: { value: 0.5, merged: 1, n: 2 },
        cost_per_merged_pr: { usd: 3.456, n: 1 },
      },
      {
        implementer_model: null, implementer_agent: null, prs_scored: 1,
        first_score: { mean: 3, median: 3, n: 1 }, final_score: { mean: 3, n: 1 },
        cycles_to_goal: { mean: null, n: 0, attempted: 0 }, merge_rate: { value: null, merged: 0, n: 0 },
        cost_per_merged_pr: { usd: null, n: 0 },
      },
    ],
  });
  assert.deepEqual(rows, [
    ["claude-opus-5-5", "2", "5.5 (n=2)", "5.5 (n=2)", "8 (n=2)", "2 (n=1)", "50% (n=2)", "$3.46 (n=1)"],
    ["(unknown)", "1", "3 (n=1)", "3 (n=1)", "3 (n=1)", "— (n=0)", "— (n=0)", "— (n=0)"],
  ]);
});

test("stats review-scores accepts the analytics periods and a JSON flag", () => {
  const command = createStatsCommand().commands.find(sub => sub.name() === "review-scores");
  assert.ok(command);
  const flags = command.options.map(option => option.long);
  assert.deepEqual(flags, ["--period", "--repository", "--json"]);
  assert.deepEqual(command.options[0].argChoices, ["24h", "7d", "30d", "90d", "1y", "all"]);
});
