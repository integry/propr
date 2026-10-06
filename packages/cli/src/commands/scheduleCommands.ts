/**
 * Scheduled Task Commands
 *
 * CLI commands for recurring task schedules: each schedule starts an ordinary
 * one-off task (a GitHub issue implemented by an agent) every time its cron
 * expression fires. Provides the `schedule` command group with `add`, `list`,
 * `remove` and `run-now` subcommands.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import {
  ProjectResolutionError,
  normalizeProjectSlug,
  printOutput,
  resolveOptionalProject,
  resolveProject,
} from "../utils/index.js";
import { classifyApiError, presentApiError } from "../utils/apiErrorPresentation.js";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  resolveIdempotencyKey,
  runScheduleNow,
  type CreateScheduleRequest,
  type RunScheduleNowResponse,
  type ScheduleInstruction,
  type TaskSchedule,
} from "../api/index.js";
import { resolveTextInput } from "./taskCommands.js";

/** Same ceiling the server applies to a per-task spend cap. */
const MAX_COST_USD = 100000;

class ScheduleUsageError extends Error {}

/** The IANA zone of this machine, used when --timezone is omitted. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Parses `--max-cost-usd`: a USD amount such as `5` or `$2.50`. */
export function parseMaxCostUsd(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^\$/, "");
  const amount = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_COST_USD) {
    throw new ScheduleUsageError(`--max-cost-usd must be a USD amount greater than 0 and at most ${MAX_COST_USD}`);
  }
  return amount;
}

function parseBound(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new ScheduleUsageError(`${flag} must be a whole number from 1 to 10`);
  }
  return parsed;
}

/** `--repo` is accepted as a spelling of `--project`; the two may not name different repositories. */
function resolveRepoOption(options: { project?: string; repo?: string }): string | undefined {
  if (options.repo === undefined) return resolveOptionalProject(options);
  const repository = normalizeProjectSlug(options.repo);
  if (!repository) throw new ProjectResolutionError(`Invalid repository "${options.repo}". Expected owner/repo format.`);
  const project = resolveOptionalProject(options);
  if (project && project.toLowerCase() !== repository.toLowerCase()) {
    throw new ProjectResolutionError(`--repo ${repository} and --project ${project} name different repositories.`);
  }
  return repository;
}

export interface ScheduleAddOptions {
  project?: string;
  repo?: string;
  cron: string;
  timezone?: string;
  name?: string;
  file?: string;
  stdin?: boolean;
  agent?: string;
  model?: string;
  ultrafix?: boolean;
  ultrafixGoal?: string;
  ultrafixMaxCycles?: string;
  autoMerge?: boolean;
  maxCostUsd?: string;
  disabled?: boolean;
  json?: boolean;
}

/** Builds the create request from parsed options; the server validates cron, zone and routing. */
export function buildScheduleRequest(repository: string, text: string, options: ScheduleAddOptions): CreateScheduleRequest {
  const ultrafixGoal = parseBound(options.ultrafixGoal, "--ultrafix-goal");
  const ultrafixMaxCycles = parseBound(options.ultrafixMaxCycles, "--ultrafix-max-cycles");
  if (!options.ultrafix && (ultrafixGoal !== undefined || ultrafixMaxCycles !== undefined)) {
    throw new ScheduleUsageError("--ultrafix-goal and --ultrafix-max-cycles require --ultrafix");
  }
  const maxCostUsd = parseMaxCostUsd(options.maxCostUsd);
  const instruction: ScheduleInstruction = {
    text,
    ...(options.agent ? { agentAlias: options.agent } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.autoMerge ? { autoMerge: true } : {}),
    ...(options.ultrafix ? { runUltrafix: true } : {}),
    ...(ultrafixGoal !== undefined ? { ultrafixGoal } : {}),
    ...(ultrafixMaxCycles !== undefined ? { ultrafixMaxCycles } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
  return {
    repository,
    cron: options.cron.trim(),
    timezone: (options.timezone ?? localTimeZone()).trim(),
    instruction,
    ...(options.name ? { name: options.name } : {}),
    ...(options.disabled ? { enabled: false } : {}),
  };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** enabled, disabled, or paused with the reason the schedule paused itself. */
export function scheduleState(schedule: Pick<TaskSchedule, "enabled" | "pausedReason">): string {
  if (schedule.enabled) return "enabled";
  return schedule.pausedReason ? `paused: ${schedule.pausedReason}` : "disabled";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/** Table rows for `schedule list`, in column order. */
export function formatScheduleRows(schedules: TaskSchedule[]): string[][] {
  return schedules.map((schedule) => [
    schedule.id,
    truncate(schedule.name, 40),
    schedule.repository,
    `${schedule.cron} (${schedule.timezone})`,
    truncate(scheduleState(schedule), 50),
    schedule.enabled ? formatDate(schedule.nextRunAt) : "-",
    formatDate(schedule.lastRunAt),
  ]);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  console.log(line(headers));
  console.log("-".repeat(line(headers).length));
  for (const row of rows) console.log(line(row));
}

function printSchedule(schedule: TaskSchedule): void {
  console.log(`  ID:         ${schedule.id}`);
  console.log(`  Name:       ${schedule.name}`);
  console.log(`  Repository: ${schedule.repository}`);
  console.log(`  Schedule:   ${schedule.cron} (${schedule.timezone})`);
  console.log(`  State:      ${scheduleState(schedule)}`);
  console.log(`  Next run:   ${schedule.enabled ? formatDate(schedule.nextRunAt) : "-"}`);
}

function failWith(error: unknown, action: string, scheduleId?: string): never {
  if (error instanceof ProjectResolutionError || error instanceof ScheduleUsageError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const classification = classifyApiError(error);
  if (scheduleId && classification.status === 404) {
    console.error(`Error: Schedule not found: ${scheduleId}`);
  } else {
    presentApiError(error, {
      forbiddenMessage: `Error: Access denied. ${classification.message || `You do not have permission to ${action}.`}`,
      fallbackMessage: (message) => `Error: Could not ${action}: ${message}`,
    });
  }
  process.exit(1);
}

async function confirm(message: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
}

/**
 * Creates the `schedule` command group.
 */
export function createScheduleCommand(): Command {
  const schedule = new Command("schedule")
    .description("Manage scheduled (recurring) tasks")
    .addHelpText("after", `
A schedule starts an ordinary task (a GitHub issue implemented by an agent)
every time its cron expression fires, on behalf of the user who created it.

Examples:
  $ propr schedule add -p myorg/myrepo --cron "0 3 * * 1" "Update outdated dependencies"
  $ propr schedule list
  $ propr schedule run-now <schedule-id>
  $ propr schedule remove <schedule-id>
`);

  schedule
    .command("add [instruction...]")
    .description("Create a schedule that starts a task every time its cron expression fires")
    .requiredOption("--cron <expression>", "5-field cron expression (minute hour day-of-month month day-of-week)")
    .option("-p, --project <project>", "Target repository (owner/repo); defaults to the configured project")
    .option("--repo <owner/repo>", "Alias for --project")
    .option("--timezone <zone>", "IANA time zone the cron expression is evaluated in (default: this machine's zone)")
    .option("-n, --name <name>", "Display name (default: the start of the instruction)")
    .option("-f, --file <path>", "Read the instruction from a file")
    .option("--stdin", "Read the instruction from standard input")
    .option("-a, --agent <agent>", "Agent alias for each run (default: the instance routing default)")
    .option("-m, --model <model>", "Model for each run")
    .option("--ultrafix", "Run the Ultrafix review/fix loop on each run's pull request")
    .option("--ultrafix-goal <score>", "Review score (1-10) Ultrafix stops at (default: instance setting)")
    .option("--ultrafix-max-cycles <n>", "Maximum Ultrafix cycles (1-10) (default: instance setting)")
    .option("--auto-merge", "Merge each run's pull request once it is ready")
    .option("--max-cost-usd <usd>", "Spend cap in USD for each run")
    .option("--disabled", "Create the schedule disabled; enable it later from the web UI")
    .option("-j, --json", "Output the created schedule as JSON")
    .addHelpText("after", `
The instruction must come from exactly one source: the argument, --file, or --stdin.
Schedules fire at most every 5 minutes. The first run is the next matching slot
after now; slots missed while ProPR was down are skipped, not replayed.

Examples:
  $ propr schedule add -p myorg/myrepo --cron "0 3 * * 1" "Update outdated dependencies and fix failing tests"
  $ propr schedule add --repo myorg/myrepo --cron "30 8 * * 1-5" --timezone Europe/Berlin --file triage.md
  $ propr schedule add --cron "0 0 1 * *" --ultrafix --auto-merge --max-cost-usd 5 "Refresh the changelog"
`)
    .action(async (instructionArg: string[] | undefined, options: ScheduleAddOptions) => {
      try {
        let text: string | undefined;
        try {
          text = (await resolveTextInput(instructionArg, options))?.trim();
        } catch (error) {
          throw new ScheduleUsageError((error as Error).message);
        }
        if (!text) throw new ScheduleUsageError("An instruction is required via an argument, --file, or --stdin.");
        const repository = resolveRepoOption(options) ?? resolveProject(options, await createConfigManager());
        const created = await createSchedule(buildScheduleRequest(repository, text, options));
        if (printOutput({ schedule: created }, options.json ?? false)) return;
        console.log("Schedule created.");
        printSchedule(created);
      } catch (error) {
        failWith(error, "create the schedule");
      }
    });

  schedule
    .command("list")
    .description("List schedules, optionally for one repository")
    .option("-p, --project <project>", "Only schedules for this repository (owner/repo)")
    .option("--repo <owner/repo>", "Alias for --project")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Without --project or --repo, schedules for every repository are listed.

Examples:
  $ propr schedule list
  $ propr schedule list --repo myorg/myrepo
  $ propr schedule list --json
`)
    .action(async (options: { project?: string; repo?: string; json?: boolean }) => {
      try {
        const repository = resolveRepoOption(options);
        const result = await listSchedules(repository);
        if (printOutput(result, options.json ?? false)) return;
        if (result.schedules.length === 0) {
          console.log(repository ? `No schedules for ${repository}.` : "No schedules.");
          console.log("");
          console.log("To add one, use:");
          console.log("  propr schedule add --cron \"<expression>\" \"<instruction>\"");
          return;
        }
        printTable(["ID", "Name", "Repository", "Schedule", "State", "Next run", "Last run"], formatScheduleRows(result.schedules));
        console.log("");
        console.log(`Total: ${result.schedules.length} schedule(s)`);
      } catch (error) {
        failWith(error, "list schedules");
      }
    });

  schedule
    .command("remove <schedule-id>")
    .alias("delete")
    .description("Delete a schedule so it never fires again; tasks it already started are kept")
    .option("-f, --force", "Skip the confirmation prompt")
    .addHelpText("after", `
Only the schedule's owner or an instance administrator can remove it.

Examples:
  $ propr schedule remove <schedule-id>
  $ propr schedule remove <schedule-id> --force
`)
    .action(async (scheduleId: string, options: { force?: boolean }) => {
      try {
        if (!options.force) {
          if (!process.stdin.isTTY) throw new ScheduleUsageError("Refusing to prompt without a terminal. Pass --force to remove the schedule.");
          const { schedule: existing } = await getSchedule(scheduleId);
          console.log(`Schedule: ${existing.name} (${existing.repository}, ${existing.cron} ${existing.timezone})`);
          if (!(await confirm("Delete this schedule?"))) {
            console.log("Deletion cancelled.");
            return;
          }
        }
        await deleteSchedule(scheduleId);
        console.log(`Schedule ${scheduleId} deleted.`);
      } catch (error) {
        failWith(error, "remove the schedule", scheduleId);
      }
    });

  schedule
    .command("run-now <schedule-id>")
    .description("Start a schedule's task once now, outside its cron slots")
    .option("--idempotency-key <key>", "Reuse a key to retry this exact request without starting a second run")
    .option("-j, --json", "Output the schedule and run as JSON")
    .addHelpText("after", `
Only the schedule's owner or an instance administrator can run it. Running a
paused schedule re-enables it. Manual runs are not limited by the instance's
unattended-work limits.

Examples:
  $ propr schedule run-now <schedule-id>
  $ propr schedule run-now <schedule-id> --json
`)
    .action(async (scheduleId: string, options: { idempotencyKey?: string; json?: boolean }) => {
      let result: RunScheduleNowResponse;
      try {
        let key: string;
        try {
          key = resolveIdempotencyKey(options.idempotencyKey);
        } catch (error) {
          throw new ScheduleUsageError((error as Error).message);
        }
        result = await runScheduleNow(scheduleId, key);
      } catch (error) {
        failWith(error, "run the schedule", scheduleId);
      }
      const { run } = result;
      const started = run.status !== "failed" && run.status !== "skipped";
      if (!printOutput(result, options.json ?? false)) {
        if (!started) {
          console.error(`Error: The run did not start: ${run.reason ?? run.status}`);
        } else {
          console.log(`Started a run of "${result.schedule.name}" in ${result.schedule.repository}.`);
          if (run.submissionId) console.log(`  Submission: ${run.submissionId}`);
          if (run.taskId) console.log(`  Task:       ${run.taskId}`);
          console.log(`  Next run:   ${result.schedule.enabled ? formatDate(result.schedule.nextRunAt) : "-"}`);
        }
      }
      if (!started) process.exit(1);
    });

  return schedule;
}
