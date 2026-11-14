/**
 * Pull request commands
 *
 * `propr pr readiness <number>` prints the read-only readiness verdict of one
 * pull request: every gate with its status and stable reason code. The read
 * never writes to GitHub, updates the branch, merges or changes auto-merge.
 */

import { Command } from "commander";
import { getPullRequestReadiness, type PullRequestReadiness } from "../api/index.js";
import { createConfigManager } from "../config/index.js";
import { parsePositiveInteger, printOutput, resolveProject, ProjectResolutionError } from "../utils/index.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

/** Human-readable lines of a readiness verdict. */
export function formatReadiness(readiness: PullRequestReadiness): string[] {
  const lines = [
    `${readiness.repository}#${readiness.number} · ${readiness.verdict.toUpperCase()} · head ${readiness.head.slice(0, 12)} → ${readiness.base}`,
    "",
  ];
  const width = Math.max(...readiness.gates.map(gate => gate.gate.length));
  for (const gate of readiness.gates) {
    lines.push(`  ${gate.gate.padEnd(width)}  ${gate.status.padEnd(14)}  ${gate.reason}${gate.detail ? ` — ${gate.detail}` : ""}`);
  }
  lines.push("");
  if (readiness.blockingReasons.length) lines.push(`Blocking: ${readiness.blockingReasons.join(", ")}`);
  if (readiness.waitingReasons.length) lines.push(`Waiting:  ${readiness.waitingReasons.join(", ")}`);
  return lines;
}

export function createPrCommand(): Command {
  const pr = new Command("pr").description("Read ProPR's view of pull requests");
  pr.addCommand(new Command("readiness")
    .description("Whether a pull request is ready to integrate, with a coded reason per gate (read-only)")
    .argument("<number>", "Pull request number")
    .option("-p, --project <project>", "Repository (owner/repo); defaults to the configured project")
    .option("--json", "Output raw JSON response")
    .addHelpText("after", `
Examples:
  $ propr pr readiness 42
  $ propr pr readiness 42 --project acme/app --json
`)
    .action(async (numberArg: string, options: { project?: string; json?: boolean }) => {
      try {
        const number = parsePositiveInteger(numberArg, "<number>");
        const repository = resolveProject(options, await createConfigManager());
        const readiness = await getPullRequestReadiness(repository, number);
        if (printOutput(readiness, options.json ?? false)) return;
        for (const line of formatReadiness(readiness)) console.log(line);
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
        } else {
          presentApiError(error, {
            forbiddenMessage: "Error: Access denied. You do not have permission to read this pull request.",
            fallbackMessage: `Error reading pull request readiness: ${(error as Error).message}`,
          });
        }
        process.exit(1);
      }
    }));
  return pr;
}
