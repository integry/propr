import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidArgumentError } from "commander";
import { createStatsCommand } from "./statsCommands.js";
import { formatCostRows, parseGroupBy } from "./statsCostCommand.js";

const figures = { tasks: 1, input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 300, cache_read_input_tokens: 400 };

test("cost rows put the grouped dimensions first and show unknowns as a dash", () => {
  const rows = formatCostRows({
    period: "30d", repository: "all", group_by: ["day", "model"],
    rows: [
      { day: "2026-11-10", model: "claude-opus-5-5", executions: 3, ...figures, cost_usd: 2.345 },
      { day: "2026-11-11", model: null, executions: 1, ...figures, cost_usd: null },
    ],
    totals: { executions: 4, ...figures, cost_usd: 2.345 },
  });
  assert.deepEqual(rows, [
    ["Day", "Model", "Runs", "Tasks", "Input", "Output", "Cache write", "Cache read", "Cost"],
    ["2026-11-10", "claude-opus-5-5", "3", "1", "1200", "80", "300", "400", "$2.35"],
    ["2026-11-11", "—", "1", "1", "1200", "80", "300", "400", "—"],
  ]);
});

test("--group-by takes a comma-separated list and rejects an unknown dimension", () => {
  assert.deepEqual(parseGroupBy("day, model,outcome"), ["day", "model", "outcome"]);
  assert.throws(() => parseGroupBy("day,price"), InvalidArgumentError);
});

test("stats cost accepts the analytics periods, a repository, groups and either JSON or CSV", async () => {
  const command = createStatsCommand().commands.find(sub => sub.name() === "cost");
  assert.ok(command);
  assert.deepEqual(command.options.map(option => option.long), ["--period", "--repository", "--group-by", "--json", "--csv"]);
  assert.deepEqual(command.options[0].argChoices, ["24h", "7d", "30d", "90d", "1y", "all"]);

  command.exitOverride().configureOutput({ writeErr: () => {} });
  await assert.rejects(command.parseAsync(["--json", "--csv"], { from: "user" }), /cannot be used with option/);
  await assert.rejects(command.parseAsync(["--group-by", "price"], { from: "user" }), /Unknown group "price"/);
});
