import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewScoreModelSummary } from "../api/index.js";
import { createStatsCommand, displayReviewScores, formatReviewScoreRows } from "./statsCommands.js";

const OPUS: ReviewScoreModelSummary = {
  implementer_model: "claude-opus-5-5", implementer_agent: "claude", prs_scored: 2,
  first_score: { mean: 5.5, median: 5.5, n: 2 }, final_score: { mean: 8, n: 2 },
  cycles_to_goal: { mean: 2, n: 1, attempted: 1 }, merge_rate: { value: 0.5, merged: 1, n: 2 },
  cost_per_merged_pr: { usd: 3.456, n: 1 }, score_delta: { mean: 2.5, n: 2 }, runs_to_merge: { mean: 3, n: 1 },
};
const UNTRACKED: ReviewScoreModelSummary = {
  implementer_model: null, implementer_agent: null, prs_scored: 1,
  first_score: { mean: 3, median: 3, n: 1 }, final_score: { mean: 3, n: 1 },
  cycles_to_goal: { mean: null, n: 0, attempted: 0 }, merge_rate: { value: null, merged: 0, n: 0 },
  cost_per_merged_pr: { usd: null, n: 0 }, score_delta: { mean: 0, n: 1 }, runs_to_merge: { mean: null, n: 0 },
};

test("review score rows are per model and effort, with every figure's denominator and unknowns as a dash", () => {
  const rows = formatReviewScoreRows({
    period: "30d", repository: "all", prs_scored: 3, scores_recorded: 4,
    models: [OPUS, UNTRACKED],
    by_effort: [
      { ...OPUS, implementer_reasoning_level: "high" },
      { ...UNTRACKED, implementer_reasoning_level: "unknown" },
    ],
  });
  assert.deepEqual(rows, [
    ["claude-opus-5-5", "high", "2", "1", "5.5 (n=2)", "5.5 (n=2)", "8 (n=2)", "2 (n=1)", "50% (n=2)", "3 (n=1)", "$3.46 (n=1)"],
    ["(unknown)", "unknown", "1", "0", "3 (n=1)", "3 (n=1)", "3 (n=1)", "— (n=0)", "— (n=0)", "— (n=0)", "— (n=0)"],
  ]);
});

test("a server that predates the effort split still prints its per-model rows", () => {
  // Older servers sent neither the effort rows nor these two figures.
  const { score_delta: _delta, runs_to_merge: _runs, ...legacy } = OPUS;
  const rows = formatReviewScoreRows({
    period: null, repository: "all", prs_scored: 2, scores_recorded: 2,
    models: [legacy as ReviewScoreModelSummary],
  });
  assert.deepEqual(rows, [
    ["claude-opus-5-5", "(all)", "2", "1", "5.5 (n=2)", "5.5 (n=2)", "8 (n=2)", "2 (n=1)", "50% (n=2)", "—", "$3.46 (n=1)"],
  ]);
});

test("stats review-scores prints a model and effort table", () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    displayReviewScores({
      period: "30d", repository: "all", prs_scored: 3, scores_recorded: 4, models: [OPUS, UNTRACKED],
      by_effort: [{ ...OPUS, implementer_reasoning_level: "xhigh" }, { ...UNTRACKED, implementer_reasoning_level: "unknown" }],
    });
  } finally {
    console.log = log;
  }
  const header = lines.find(line => line.startsWith("Model"))!;
  assert.match(header, /^Model\s+Effort\s+PRs\s+Merged\s+First mean.*Runs to merge\s+Cost\/merged PR$/);
  assert.ok(lines.some(line => /^claude-opus-5-5\s+xhigh\s+2\s+1\s/.test(line)));
  assert.ok(lines.some(line => /^\(unknown\)\s+unknown\s+1\s+0\s/.test(line)));
});

test("stats review-scores accepts the analytics periods and a JSON flag", () => {
  const command = createStatsCommand().commands.find(sub => sub.name() === "review-scores");
  assert.ok(command);
  const flags = command.options.map(option => option.long);
  assert.deepEqual(flags, ["--period", "--repository", "--json"]);
  assert.deepEqual(command.options[0].argChoices, ["24h", "7d", "30d", "90d", "1y", "all"]);
});
