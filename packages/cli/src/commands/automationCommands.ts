/**
 * Automation Commands
 *
 * The `automation` command group (alias `automations`) drives Agents, the
 * saved automations shown as "Agents" in the Web UI. It is a separate group
 * because `propr agent` manages coding-agent configurations (Claude, Codex, …).
 *
 * `run` is the CLI surface of the trigger primitive, and the simplest hook
 * for external cron or CI: it sends an Idempotency-Key so a retried trigger
 * never creates a second run. Every command prints a human-readable view or a
 * versioned `--json` document.
 */

import { Command } from "commander";
import { TERMINAL_AGENT_RUN_STATES, type AgentRunState } from "@propr/shared";
import { ApiError } from "../api/errors.js";
import { GoalMutationUncertainError, resolveIdempotencyKey } from "../api/goals.js";
import {
  approveAutomationRun,
  cancelAutomationRun,
  getAutomation,
  getAutomationRun,
  listAutomationRuns,
  listAutomations,
  rejectAutomationRun,
  triggerAutomationRun,
  type Automation,
  type AutomationRun,
} from "../api/automations.js";
import { classifyApiError, presentApiError } from "../utils/apiErrorPresentation.js";
import { parsePositiveInteger } from "../utils/index.js";

/** Version of every `propr automation ... --json` document. Bump only on breaking shape changes. */
export const AUTOMATION_JSON_VERSION = 1;

/** Documented `propr automation run` exit codes. */
export const AUTOMATION_RUN_EXIT_CODES = {
  completed: 0,
  error: 1,
  timed_out: 2,
  not_run: 3,
  awaiting_approval: 4,
} as const;

export const AUTOMATION_RUN_POLL_INTERVAL_MS = 5_000;
export const AUTOMATION_RUN_DEFAULT_TIMEOUT_SECONDS = 1_800;
export const AUTOMATION_RUN_MAX_TIMEOUT_SECONDS = 86_400;

/** States at which `run --wait` stops polling. Deferred runs may wait hours for capacity. */
const WAIT_STOP_STATES: readonly AgentRunState[] = [...TERMINAL_AGENT_RUN_STATES, "awaiting_approval", "deferred"];

export type AutomationFailureCode =
  | "invalid_arguments"
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "state_conflict"
  | "outcome_uncertain"
  | "server_error"
  | "network_error"
  | "request_failed";

class AutomationUsageError extends Error {}

export interface AutomationCommandOptions {
  /** Poll interval for `run --wait`; tests shorten it. */
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Exit code for a run in `state`; `null` while the run is still in progress. */
export function automationRunExitCode(state: AgentRunState): number | null {
  switch (state) {
    case "completed":
      return AUTOMATION_RUN_EXIT_CODES.completed;
    case "skipped":
    case "deferred":
      return AUTOMATION_RUN_EXIT_CODES.not_run;
    case "awaiting_approval":
      return AUTOMATION_RUN_EXIT_CODES.awaiting_approval;
    case "failed":
    case "rejected":
    case "cancelled":
      return AUTOMATION_RUN_EXIT_CODES.error;
    default:
      return null;
  }
}

function printJson(value: Record<string, unknown>): void {
  console.log(JSON.stringify({ version: AUTOMATION_JSON_VERSION, ...value }, null, 2));
}

function formatTimestamp(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 3)}...`;
}

function printTable(columns: Array<{ heading: string; values: string[] }>): void {
  const widths = columns.map((column) => Math.max(column.heading.length, ...column.values.map((value) => value.length)));
  const header = columns.map((column, index) => column.heading.padEnd(widths[index])).join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  const rows = columns[0]?.values.length ?? 0;
  for (let row = 0; row < rows; row++) {
    console.log(columns.map((column, index) => column.values[row].padEnd(widths[index])).join("  "));
  }
}

function scheduleLabel(automation: Automation): string {
  if (!automation.scheduleCron) return "-";
  return `${automation.scheduleCron}${automation.scheduleEnabled ? "" : " (off)"}`;
}

function printAutomation(automation: Automation): void {
  console.log(`Agent:        ${automation.id}`);
  console.log(`Name:         ${automation.name}`);
  if (automation.description) console.log(`Description:  ${automation.description}`);
  console.log(`Enabled:      ${automation.enabled ? "yes" : "no"}`);
  console.log(`Autonomy:     ${automation.autonomyMode}`);
  console.log(`Repositories: ${automation.repositories.join(", ") || "-"}`);
  console.log(`Coding agent: ${automation.agentAlias ?? "(default)"}${automation.modelName ? ` / ${automation.modelName}` : ""}`);
  console.log(`Capabilities: ${automation.capabilities.join(", ") || "-"}`);
  console.log(`Schedule:     ${automation.scheduleCron ? `${automation.scheduleCron} ${automation.scheduleTimezone}${automation.scheduleEnabled ? "" : " (disabled)"}` : "-"}`);
  if (automation.nextRunAt) console.log(`Next run:     ${formatTimestamp(automation.nextRunAt)}`);
  console.log(`Previous reports: ${automation.includePreviousReports ? automation.previousReportsLimit : 0}`);
  if (automation.attachments.length > 0) console.log(`Input files:  ${automation.attachments.length}`);
  console.log(`Updated:      ${formatTimestamp(automation.updatedAt)}`);
  console.log("");
  console.log("Prompt:");
  console.log(automation.prompt);
}

/** Run metadata as `key: value` lines, written to `write` (stdout or stderr). */
function printRunMetadata(run: AutomationRun, write: (line: string) => void): void {
  write(`run: ${run.id}`);
  write(`agent: ${run.definitionId}`);
  write(`state: ${run.state}`);
  write(`trigger: ${run.trigger}${run.triggerSource ? ` (${run.triggerSource})` : ""}`);
  write(`created at: ${formatTimestamp(run.createdAt)}`);
  if (run.reportedAt) write(`reported at: ${formatTimestamp(run.reportedAt)}`);
  if (run.finishedAt) write(`finished at: ${formatTimestamp(run.finishedAt)}`);
}

/** Why a run did not complete, always on stderr so stdout stays pipe-friendly. */
function printRunOutcomeNotes(run: AutomationRun): void {
  if (run.state === "deferred") {
    console.error(`Deferred: ${run.skipReason ?? "the run is waiting for provider capacity"}`);
    if (run.deferredUntil) console.error(`Retry after: ${formatTimestamp(run.deferredUntil)}`);
  } else if (run.state === "skipped") {
    console.error(`Skipped: ${run.skipReason ?? "the run was skipped"}`);
  } else if (run.state === "failed") {
    console.error(`Failed: ${run.failureReason ?? "the run failed"}`);
  } else if (run.state === "awaiting_approval") {
    console.error(`Awaiting approval. Approve with: propr automation approve ${run.id}  (or reject with: propr automation reject ${run.id})`);
  } else if (run.state === "rejected" || run.state === "cancelled") {
    console.error(`The run was ${run.state}.`);
  }
}

/** The report is the only stdout content of `report` and `run --wait`. */
function writeReport(report: string): void {
  console.log(report.endsWith("\n") ? report.slice(0, -1) : report);
}

function runJson(run: AutomationRun): Record<string, unknown> {
  return { ...run, terminal: (TERMINAL_AGENT_RUN_STATES as readonly string[]).includes(run.state) };
}

interface FailureContext {
  command: string;
  json?: boolean;
  automationId?: string;
  runId?: string;
  idempotencyKey?: string;
}

function failureCode(error: unknown): { code: AutomationFailureCode; status?: number } {
  if (error instanceof AutomationUsageError) return { code: "invalid_arguments" };
  if (error instanceof GoalMutationUncertainError) return { code: "outcome_uncertain" };
  const classification = classifyApiError(error);
  const status = classification.status;
  if (classification.kind === "unauthorized") return { code: "unauthorized", status };
  if (classification.kind === "forbidden") return { code: "forbidden", status };
  if (status === 400) return { code: "validation_failed", status };
  if (status === 404) return { code: "not_found", status };
  if (status === 409) return { code: "state_conflict", status };
  if (status !== undefined && status >= 500) return { code: "server_error", status };
  if (error instanceof ApiError && status === 0) return { code: "network_error" };
  if (error instanceof ApiError) return { code: "request_failed", status };
  return { code: "invalid_arguments" };
}

function notFoundMessage(context: FailureContext): string {
  return context.runId ? `Error: Agent run not found: ${context.runId}` : `Error: Agent not found${context.automationId ? `: ${context.automationId}` : ""}`;
}

function recoveryHint(error: unknown, context: FailureContext, code: AutomationFailureCode): string | null {
  if (code === "outcome_uncertain" && error instanceof GoalMutationUncertainError) {
    return `The run may already have been created. Re-run the same command with --idempotency-key ${error.idempotencyKey}; it will not create a second run.`;
  }
  if (context.command === "run" && context.idempotencyKey && code !== "invalid_arguments") {
    return `To retry safely, re-run with --idempotency-key ${context.idempotencyKey}.`;
  }
  return null;
}

/**
 * Prints a failure (JSON document on stdout with --json, message on stderr otherwise) and sets exit
 * status 1. It does not force termination, so piped output is flushed; callers must return after it.
 */
function fail(error: unknown, context: FailureContext): void {
  const { code, status } = failureCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const idempotencyKey = error instanceof GoalMutationUncertainError ? error.idempotencyKey : context.idempotencyKey;
  const recovery = recoveryHint(error, context, code);
  if (context.json) {
    printJson({
      kind: "automation-error",
      command: context.command,
      error: {
        code,
        message,
        status: status ?? null,
        ...(context.automationId ? { automationId: context.automationId } : {}),
        ...(context.runId ? { runId: context.runId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        recovery,
      },
    });
  } else if (code === "invalid_arguments") {
    console.error(`Error: ${message}`);
  } else if (code === "outcome_uncertain") {
    console.error(`Error: Could not confirm the outcome (${message}).`);
  } else {
    presentApiError(error, {
      forbiddenMessage: `Error: Access denied. ${message}`,
      fallbackMessage: (text) => (code === "not_found" ? notFoundMessage(context) : `Error: ${text}`),
    });
  }
  if (!context.json && recovery) console.error(recovery);
  process.exitCode = AUTOMATION_RUN_EXIT_CODES.error;
}

function parseLimit(value: string | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  let parsed: number;
  try {
    parsed = parsePositiveInteger(value, "--limit");
  } catch (error) {
    throw new AutomationUsageError((error as Error).message);
  }
  if (parsed > max) throw new AutomationUsageError(`--limit must be an integer from 1 to ${max}.`);
  return parsed;
}

function parseOffset(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AutomationUsageError("--offset must be a non-negative integer.");
  }
  return Number(value);
}

function parseTimeout(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > AUTOMATION_RUN_MAX_TIMEOUT_SECONDS) {
    throw new AutomationUsageError(`--timeout must be an integer from 0 to ${AUTOMATION_RUN_MAX_TIMEOUT_SECONDS} seconds.`);
  }
  return Number(value);
}

function parseIdempotencyKey(value: string | undefined): string {
  try {
    return resolveIdempotencyKey(value);
  } catch (error) {
    throw new AutomationUsageError((error as Error).message);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches the run, aborting the request when the wait deadline arrives.
 * Returns `null` when the deadline passes before or during the request.
 */
async function pollBeforeDeadline(
  runId: string,
  deadline: number,
  settings: Required<AutomationCommandOptions>,
): Promise<AutomationRun | null> {
  const remaining = deadline - settings.now();
  if (remaining <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const run = await getAutomationRun(runId, { signal: controller.signal });
    return settings.now() >= deadline ? null : run;
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls the run until it reaches a stop state or the deadline passes. State
 * changes are reported on stderr so stdout only carries the report.
 */
async function waitForRun(
  initial: AutomationRun,
  deadline: number,
  settings: Required<AutomationCommandOptions>,
  quiet: boolean,
): Promise<{ run: AutomationRun; timedOut: boolean }> {
  let run = initial;
  while (!WAIT_STOP_STATES.includes(run.state)) {
    const remaining = deadline - settings.now();
    if (remaining <= 0) return { run, timedOut: true };
    await settings.sleep(Math.min(settings.pollIntervalMs, remaining));
    const next = await pollBeforeDeadline(run.id, deadline, settings);
    // A poll that could not answer before the deadline leaves the last known run.
    if (!next) return { run, timedOut: true };
    const previous = run.state;
    run = next;
    if (!quiet && run.state !== previous) console.error(`state: ${run.state}`);
  }
  return { run, timedOut: false };
}

interface RunOptions {
  idempotencyKey?: string;
  source?: string;
  wait?: boolean;
  timeout: string;
  json?: boolean;
}

/**
 * Creates the `automation` command group.
 */
export function createAutomationCommand(commandOptions: AutomationCommandOptions = {}): Command {
  const settings: Required<AutomationCommandOptions> = {
    pollIntervalMs: commandOptions.pollIntervalMs ?? AUTOMATION_RUN_POLL_INTERVAL_MS,
    now: commandOptions.now ?? Date.now,
    sleep: commandOptions.sleep ?? defaultSleep,
  };

  const automation = new Command("automation")
    .alias("automations")
    .description("Agents (saved automations): list, run, and review agent runs and reports")
    .addHelpText("after", `
Agents (saved automations) are reusable prompts that run on demand or on a
schedule and produce a report; in preview mode their acting step waits for
your approval. They are shown as "Agents" in the Web UI. This group is
separate from 'propr agent', which manages coding-agent configurations
(Claude, Codex, ...).

Every command accepts --json and prints a { "version": 1, "kind": ... }
document. Failures exit 1; with --json they print an "automation-error"
document with a machine-readable error.code.

Examples:
  $ propr automation list
  $ propr automation show <agent-id>
  $ propr automation run <agent-id> --wait
  $ propr automation runs <agent-id> --limit 5
  $ propr automation report <run-id> > report.md
  $ propr automation approve <run-id> --note "Only open issues for the top two findings"
`);

  automation
    .command("list")
    .description("List your agents (saved automations)")
    .option("-l, --limit <limit>", "Page size (1-200)")
    .option("--offset <offset>", "Number of agents to skip")
    .option("-j, --json", "Output the version 1 automation-list JSON document")
    .action(async (options: { limit?: string; offset?: string; json?: boolean }) => {
      try {
        const page = await listAutomations({ limit: parseLimit(options.limit, 200), offset: parseOffset(options.offset) });
        if (options.json) {
          printJson({ kind: "automation-list", total: page.total, limit: page.limit, offset: page.offset, automations: page.automations });
          return;
        }
        if (page.automations.length === 0) {
          console.log("No agents found. Create one on the Agents page of the Web UI.");
          return;
        }
        const items = page.automations;
        printTable([
          { heading: "ID", values: items.map((item) => item.id) },
          { heading: "Name", values: items.map((item) => truncate(item.name, 32)) },
          { heading: "Enabled", values: items.map((item) => (item.enabled ? "yes" : "no")) },
          { heading: "Autonomy", values: items.map((item) => item.autonomyMode) },
          { heading: "Schedule", values: items.map(scheduleLabel) },
          { heading: "Next run", values: items.map((item) => formatTimestamp(item.nextRunAt)) },
        ]);
        const next = page.offset + items.length;
        if (next < page.total) {
          console.log("");
          console.log(`Showing ${items.length} of ${page.total}. More agents: --offset ${next}`);
        }
      } catch (error) {
        return fail(error, { command: "list", json: options.json });
      }
    });

  automation
    .command("show <id>")
    .description("Show an agent's prompt, schedule, autonomy and repositories")
    .option("-j, --json", "Output the version 1 automation JSON document")
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const item = await getAutomation(id);
        if (options.json) {
          printJson({ kind: "automation", automation: item });
          return;
        }
        printAutomation(item);
      } catch (error) {
        return fail(error, { command: "show", json: options.json, automationId: id });
      }
    });

  automation
    .command("run <id>")
    .description("Trigger a run of an agent (idempotent with --idempotency-key)")
    .option("--idempotency-key <key>", "Reuse a key to retry this trigger without creating a second run (default: a new cli-<uuid>)")
    .option("--source <label>", "Free-form label recorded with the run (e.g. github-actions)")
    .option("--wait", "Poll the run every 5 seconds until it finishes or awaits approval, then print the report")
    .option("--timeout <seconds>", `With --wait, give up after this many seconds (0-${AUTOMATION_RUN_MAX_TIMEOUT_SECONDS})`, String(AUTOMATION_RUN_DEFAULT_TIMEOUT_SECONDS))
    .option("-j, --json", "Output the version 1 automation-run JSON document")
    .addHelpText("after", `
Triggering is idempotent per key: running the same command twice with the same
--idempotency-key returns the first run ("created: false") instead of starting
another. Without --idempotency-key the CLI generates one and prints it, so a
failed command can be retried safely with that key.

Scheduled-style triggers go through the usage gate: when provider capacity is
low the run is deferred or skipped and the reason is printed on stderr.

Without --wait the run id, state and key are printed on stdout. With --wait
that metadata and state changes go to stderr, and the report Markdown goes to
stdout, so the output can be piped or redirected.

Exit codes:
  ${AUTOMATION_RUN_EXIT_CODES.completed}  completed (or, without --wait, accepted and in progress)
  ${AUTOMATION_RUN_EXIT_CODES.timed_out}  timed out waiting (the run continues on the server)
  ${AUTOMATION_RUN_EXIT_CODES.not_run}  skipped or deferred (the reason is on stderr)
  ${AUTOMATION_RUN_EXIT_CODES.awaiting_approval}  awaiting approval (preview agents)
  ${AUTOMATION_RUN_EXIT_CODES.error}  failed, rejected, cancelled, or error

JSON:
  { "version": 1, "kind": "automation-run", "action": "run", "created": boolean,
    "idempotencyKey": "...", "attempts": n, "waited": boolean, "timedOut": boolean,
    "exitCode": n, "run": { "id", "state", "report", "skipReason", "failureReason", ... } }

GitHub Actions example:
  - name: Run the weekly triage agent
    run: npx propr-cli automation run "$AGENT_ID" --idempotency-key "$GITHUB_RUN_ID" --source github-actions --wait > report.md
    env:
      AGENT_ID: <agent-id>
`)
    .action(async (id: string, options: RunOptions) => {
      let key: string | undefined;
      let exitCode: number = AUTOMATION_RUN_EXIT_CODES.completed;
      try {
        key = parseIdempotencyKey(options.idempotencyKey);
        const timeoutSeconds = parseTimeout(options.timeout);
        const source = options.source?.trim() || undefined;
        const deadline = settings.now() + timeoutSeconds * 1000;
        const result = await triggerAutomationRun(id, { idempotencyKey: key, source });

        // Without --wait stdout carries the metadata; with --wait it is reserved for the report.
        const meta = (line: string) => (options.wait ? console.error(line) : console.log(line));
        if (!options.json) {
          meta(result.created ? "Run started." : "This idempotency key already created this run; no new run was started.");
          meta(`run: ${result.run.id}`);
          meta(`state: ${result.run.state}`);
          meta(`created: ${result.created}`);
          meta(`idempotency key: ${result.idempotencyKey}`);
        }

        let run = result.run;
        let timedOut = false;
        if (options.wait) ({ run, timedOut } = await waitForRun(run, deadline, settings, Boolean(options.json)));

        exitCode = timedOut
          ? AUTOMATION_RUN_EXIT_CODES.timed_out
          : automationRunExitCode(run.state) ?? AUTOMATION_RUN_EXIT_CODES.completed;

        if (options.json) {
          printJson({
            kind: "automation-run",
            action: "run",
            automationId: id,
            created: result.created,
            idempotencyKey: result.idempotencyKey,
            attempts: result.attempts,
            waited: Boolean(options.wait),
            timedOut,
            exitCode,
            run: runJson(run),
          });
        } else {
          if (timedOut) {
            console.error(`Timed out after ${timeoutSeconds}s waiting for run ${run.id} (state: ${run.state}). The run continues on the server.`);
            console.error(`Check it later with: propr automation report ${run.id}`);
          }
          printRunOutcomeNotes(run);
          if (options.wait && !timedOut && run.report) writeReport(run.report);
          if (options.wait && run.actionSummary) {
            console.error("");
            console.error("Action summary:");
            console.error(run.actionSummary);
          }
        }
      } catch (error) {
        return fail(error, { command: "run", json: options.json, automationId: id, idempotencyKey: key });
      }
      // Set rather than exit so buffered stdout (the report or JSON) is flushed before the process ends.
      if (exitCode !== AUTOMATION_RUN_EXIT_CODES.completed) process.exitCode = exitCode;
    });

  automation
    .command("runs <id>")
    .description("List an agent's runs, newest first")
    .option("-l, --limit <limit>", "Page size (1-200)", "20")
    .option("--offset <offset>", "Number of runs to skip")
    .option("-j, --json", "Output the version 1 automation-runs JSON document")
    .action(async (id: string, options: { limit: string; offset?: string; json?: boolean }) => {
      try {
        const page = await listAutomationRuns(id, { limit: parseLimit(options.limit, 200), offset: parseOffset(options.offset) });
        if (options.json) {
          printJson({ kind: "automation-runs", automationId: id, total: page.total, limit: page.limit, offset: page.offset, runs: page.runs.map(runJson) });
          return;
        }
        if (page.runs.length === 0) {
          console.log("This agent has no runs yet.");
          return;
        }
        const runs = page.runs;
        printTable([
          { heading: "Run", values: runs.map((item) => item.id) },
          { heading: "State", values: runs.map((item) => item.state) },
          { heading: "Trigger", values: runs.map((item) => truncate(`${item.trigger}${item.triggerSource ? ` (${item.triggerSource})` : ""}`, 32)) },
          { heading: "Created", values: runs.map((item) => formatTimestamp(item.createdAt)) },
          { heading: "Note", values: runs.map((item) => truncate(item.failureReason ?? item.skipReason ?? "", 48)) },
        ]);
        const next = page.offset + runs.length;
        if (next < page.total) {
          console.log("");
          console.log(`Showing ${runs.length} of ${page.total}. More runs: --offset ${next}`);
        }
      } catch (error) {
        return fail(error, { command: "runs", json: options.json, automationId: id });
      }
    });

  automation
    .command("report <runId>")
    .description("Print a run's report Markdown to stdout (metadata goes to stderr)")
    .option("-j, --json", "Output the version 1 automation-run JSON document")
    .addHelpText("after", `
Only the report Markdown is written to stdout, so it can be piped or saved:
  $ propr automation report <run-id> > report.md
Exits 1 when the run has no report yet.
`)
    .action(async (runId: string, options: { json?: boolean }) => {
      let missing = false;
      try {
        const run = await getAutomationRun(runId);
        missing = !run.report;
        if (options.json) {
          printJson({ kind: "automation-run", action: "report", run: runJson(run) });
        } else {
          printRunMetadata(run, (line) => console.error(line));
          if (run.reportTruncated) console.error("note: the report was truncated; the full output is in the task logs");
          printRunOutcomeNotes(run);
          if (run.report) {
            console.error("");
            writeReport(run.report);
          } else {
            console.error(`Run ${run.id} has no report yet (state: ${run.state}).`);
          }
        }
      } catch (error) {
        return fail(error, { command: "report", json: options.json, runId });
      }
      if (missing) process.exitCode = AUTOMATION_RUN_EXIT_CODES.error;
    });

  const decision = (
    action: "approve" | "reject" | "cancel",
    description: string,
    perform: (runId: string, options: { note?: string }) => Promise<AutomationRun>,
  ): Command => automation
    .command(`${action} <runId>`)
    .description(description)
    .option("-j, --json", "Output the version 1 automation-run JSON document")
    .action(async (runId: string, options: { note?: string; json?: boolean }) => {
      try {
        const run = await perform(runId, options);
        if (options.json) {
          printJson({ kind: "automation-run", action, run: runJson(run) });
          return;
        }
        const verb = { approve: "Approved", reject: "Rejected", cancel: "Cancelled" }[action];
        console.log(`${verb} run ${run.id}.`);
        console.log(`state: ${run.state}`);
      } catch (error) {
        return fail(error, { command: action, json: options.json, runId });
      }
    });

  decision("approve", "Approve a run awaiting approval; its acting step starts", (runId, options) =>
    approveAutomationRun(runId, { note: options.note }))
    .option("--note <text>", "Guidance for the acting step (stored with the approval)");
  decision("reject", "Reject a run awaiting approval; nothing is acted on", (runId) => rejectAutomationRun(runId));
  decision("cancel", "Cancel a queued, deferred, running, awaiting or acting run", (runId) => cancelAutomationRun(runId));

  return automation;
}
