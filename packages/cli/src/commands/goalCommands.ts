/**
 * Goal Commands
 *
 * The `goal` command group: create, inspect, steer, pause, resume, cancel and
 * re-model long-running goals through the same owner-scoped API as the Web UI.
 * Every command prints a human-readable view or a versioned `--json` result.
 * Mutations carry an idempotency key so retries never start a second goal or
 * queue a second input.
 */

import { Command, type ErrorOptions, type ParseOptionsResult } from "commander";
import { createConfigManager } from "../config/index.js";
import { parsePositiveInteger, resolveOptionalProject, resolveProject, ProjectResolutionError } from "../utils/index.js";
import { classifyApiError, LOGIN_REQUIRED_ERROR } from "../utils/apiErrorPresentation.js";
import { ApiError } from "../api/errors.js";
import {
  GOAL_LAUNCH_STRATEGIES,
  GOAL_LIST_STATES,
  GoalMutationUncertainError,
  cancelGoal,
  createGoal,
  getGoalCapabilities,
  getGoalDetail,
  listGoalAttention,
  listGoalInputs,
  listGoals,
  pauseGoal,
  resolveIdempotencyKey,
  resumeGoal,
  sendGoalInput,
  setGoalModel,
  type CreateGoalRequest,
  type Goal,
  type GoalAttentionEntry,
  type GoalCapabilityAgent,
  type GoalDetail,
  type GoalInput,
  type GoalLaunchStrategy,
  type GoalListState,
  type GoalMutationResult,
} from "../api/goals.js";
import type { GoalBlocker, GoalBlockerAction } from "@propr/shared";
import { resolveTextInput } from "./taskCommands.js";

/** Version of every `propr goal ... --json` document. Bump only on breaking shape changes. */
export const GOAL_JSON_VERSION = 1;

const CANNED_INPUTS = { done: "What's done?", left: "What's left?" } as const;
type CannedInput = keyof typeof CANNED_INPUTS;

/** Machine-readable failure codes emitted in `--json` error documents. */
export type GoalFailureCode =
  | "invalid_arguments"
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "idempotency_conflict"
  | "agent_not_goal_capable"
  | "state_conflict"
  | "outcome_uncertain"
  | "server_error"
  | "network_error"
  | "request_failed";

class GoalUsageError extends Error {}

/** What the provider/worker has confirmed, as opposed to the requested `desiredState`. */
export type GoalObservedState =
  | "starting"
  | "running"
  | "resuming"
  | "pausing"
  | "paused"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export function observedGoalState(
  goal: Pick<Goal, "resultState" | "desiredState" | "pausePending" | "startedAt"> & { control?: Pick<Goal["control"], "pending"> | null },
): GoalObservedState {
  if (goal.resultState) return goal.resultState;
  if (goal.desiredState === "cancelled") return "cancelling";
  if (goal.desiredState === "paused") return goal.pausePending ? "pausing" : "paused";
  if (!goal.startedAt) return "starting";
  // A continuation (resume, or a model change's restart) is only running once the provider acknowledges it.
  return goal.control?.pending ? "resuming" : "running";
}

/** Requested controls vs confirmed state, and goal completion vs task completion, kept explicitly apart. */
function goalJson(goal: Goal): Record<string, unknown> {
  return {
    id: goal.id,
    repository: goal.repository,
    title: goal.title,
    objective: goal.objective,
    launchStrategy: goal.launchStrategy,
    agent: goal.agent,
    baseBranch: goal.baseBranch,
    branchName: goal.branchName,
    maxParallelTasks: goal.maxParallelTasks,
    ultrafix: goal.ultrafix,
    lifecycle: {
      requestedState: goal.desiredState,
      observedState: observedGoalState(goal),
      resultState: goal.resultState,
      terminal: goal.resultState !== null,
      goalCompleted: goal.resultState === "completed",
      pausePending: goal.pausePending,
      controlPending: goal.control?.pending ?? false,
      controlGeneration: {
        requested: goal.control?.requestGeneration ?? 0,
        acknowledged: goal.control?.acknowledgedGeneration ?? 0,
      },
    },
    model: {
      requested: goal.requestedModel,
      effective: goal.effectiveModel,
      confirmed: goal.effectiveModel !== null && goal.effectiveModel === goal.requestedModel
        && !(goal.control?.pending ?? false),
    },
    currentTask: {
      id: goal.taskId,
      state: goal.taskState,
      // A completed provider task does not mean the goal itself is complete.
      taskCompleted: goal.taskState === "completed",
    },
    sessionId: goal.sessionId,
    conversationId: goal.conversationId,
    failure: goal.failureReason ? { reason: goal.failureReason } : null,
    checkpoint: goal.checkpoint,
    finalPr: goal.finalPr,
    timing: {
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      startedAt: goal.startedAt,
      pausedAt: goal.pausedAt,
      completedAt: goal.completedAt,
      elapsedMs: goal.elapsedMs,
      pausedMs: goal.pausedMs,
      activeMs: goal.activeMs,
    },
  };
}

function goalDetailJson(goal: Goal, detail: GoalDetail): Record<string, unknown> {
  const base = goalJson(goal);
  const transitions = detail.progress?.recentTerminalTransitions ?? [];
  return {
    ...base,
    narration: detail.currentActivity,
    progress: {
      tasks: detail.progress?.tasks ?? null,
      recentTerminalTransitions: transitions,
      elapsedSeconds: detail.progress?.elapsedSeconds ?? null,
    },
    pendingInput: detail.pendingInput,
    attention: goal.attention ?? null,
    failure: goal.failureReason || transitions.some((transition) => transition.state === "failed")
      ? {
        reason: goal.failureReason,
        failedTasks: transitions.filter((transition) => transition.state === "failed"),
      }
      : null,
    checkpoint: goal.checkpoint ?? detail.progress?.checkpoint ?? null,
    pullRequests: detail.pullRequests ?? [],
  };
}

const BLOCKER_LABELS: Record<GoalBlocker["category"], string> = {
  question: "asked a question",
  approval: "waiting for an approval",
  paused: "paused and waiting for you",
};

/** The CLI command that performs each supported response action. */
function blockerActionCommand(goalId: string, action: GoalBlockerAction): string {
  return action === "send_input" ? `propr goal input ${goalId} "<answer>"` : `propr goal ${action} ${goalId}`;
}

/** Provider text is untrusted data: printed on its own line, never interpreted. */
function printBlockers(goalId: string, blockers: GoalBlocker[], indent = "  "): void {
  for (const blocker of blockers) {
    console.log(`${indent}- ${BLOCKER_LABELS[blocker.category]}${blocker.firstObservedAt ? ` (since ${formatDate(blocker.firstObservedAt)})` : ""}`);
    if (blocker.category !== "paused") console.log(`${indent}  ${blocker.summary}`);
    for (const question of blocker.questions.length > 1 ? blocker.questions : []) {
      console.log(`${indent}  * ${question.question}${question.options.length ? ` [${question.options.join(" | ")}]` : ""}`);
    }
    console.log(`${indent}  ${blocker.responseHint}`);
    for (const action of blocker.responseActions) console.log(`${indent}  > ${blockerActionCommand(goalId, action)}`);
  }
}

function inputJson(input: GoalInput): Record<string, unknown> {
  return {
    ...input,
    queued: true,
    delivered: input.state === "delivered",
    // ProPR records delivery to the provider; it cannot observe whether the agent acted on it.
    actedOn: null,
  };
}

function printJson(value: Record<string, unknown>): void {
  console.log(JSON.stringify({ version: GOAL_JSON_VERSION, ...value }, null, 2));
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

function stateLine(goal: Goal): string {
  const observed = observedGoalState(goal);
  const requested = goal.resultState ? null : goal.desiredState;
  return requested && requested !== observed ? `${observed} (requested: ${requested})` : observed;
}

function modelLine(goal: Goal): string {
  if (!goal.effectiveModel) return `${goal.requestedModel} (requested; not yet confirmed by the provider)`;
  if (goal.effectiveModel !== goal.requestedModel) return `${goal.effectiveModel} (change to ${goal.requestedModel} requested)`;
  return goal.effectiveModel;
}

function printGoalSummary(goal: Goal): void {
  console.log(`Goal:        ${goal.id}`);
  console.log(`Title:       ${goal.title}`);
  console.log(`Repository:  ${goal.repository}`);
  console.log(`State:       ${stateLine(goal)}`);
  console.log(`Agent:       ${goal.agent.alias} (${goal.agent.type})`);
  console.log(`Model:       ${modelLine(goal)}`);
  console.log(`Task:        ${goal.taskId} (${goal.taskState})`);
  if (goal.finalPr) console.log(`Final PR:    #${goal.finalPr.number ?? "?"} ${goal.finalPr.url}`);
}

function printGoalDetail(goal: Goal, detail: GoalDetail): void {
  console.log("");
  console.log("=".repeat(60));
  console.log("Goal Details");
  console.log("=".repeat(60));
  printGoalSummary(goal);
  console.log(`Strategy:    ${goal.launchStrategy}${goal.maxParallelTasks ? ` (max ${goal.maxParallelTasks} parallel tasks)` : ""}`);
  if (goal.baseBranch) console.log(`Base branch: ${goal.baseBranch}`);
  if (goal.branchName) console.log(`Branch:      ${goal.branchName}`);
  if (goal.ultrafix) console.log("Ultrafix:    on");
  console.log(`Goal done:   ${goal.resultState === "completed" ? "yes" : "no"}${goal.resultState && goal.resultState !== "completed" ? ` (${goal.resultState})` : ""}`);
  console.log(`Elapsed:     ${formatDuration(goal.elapsedMs)} (active ${formatDuration(goal.activeMs)}, paused ${formatDuration(goal.pausedMs)})`);
  console.log(`Updated:     ${formatDate(goal.updatedAt)}`);
  if (goal.control?.pending) {
    console.log("Controls:    a control request is waiting for the provider to acknowledge it");
  }

  const tasks = detail.progress?.tasks;
  if (tasks) {
    console.log("");
    console.log(`Tasks:       ${tasks.total} total, ${tasks.active} active, ${tasks.completed} completed, ${tasks.failed} failed, ${tasks.cancelled} cancelled`);
  }

  const pending = detail.pendingInput;
  if (pending) {
    const blockers = goal.attention?.blockers ?? [];
    if (blockers.length > 0) {
      console.log("Waiting:     the goal needs you");
      printBlockers(goal.id, blockers, "             ");
    } else if (pending.waitingForOperator) {
      console.log("Waiting:     paused and waiting for you (resume or send input)");
    }
    if (pending.undeliveredInputs > 0) console.log(`Inputs:      ${pending.undeliveredInputs} queued, not yet delivered`);
  }

  if (goal.checkpoint) {
    const checkpoint = goal.checkpoint;
    console.log("");
    console.log("Checkpoints:");
    console.log(`  Interval:  ${checkpoint.intervalMinutes ?? "-"} min, ${checkpoint.count} taken${checkpoint.pending ? ", one pending" : ""}`);
    if (checkpoint.lastAt) console.log(`  Last:      ${formatDate(checkpoint.lastAt)}${checkpoint.lastCommitSha ? ` (${checkpoint.lastCommitSha.slice(0, 12)})` : ""}`);
    if (checkpoint.error) console.log(`  Error:     ${checkpoint.error}`);
  }

  const failedTasks = (detail.progress?.recentTerminalTransitions ?? []).filter((item) => item.state === "failed");
  if (goal.failureReason || failedTasks.length > 0) {
    console.log("");
    console.log("Failure:");
    if (goal.failureReason) console.log(`  ${goal.failureReason}`);
    for (const failed of failedTasks) {
      console.log(`  Task ${failed.taskId} failed${failed.at ? ` at ${formatDate(failed.at)}` : ""}${failed.reason ? `: ${failed.reason}` : ""}`);
    }
  }

  const focus = detail.currentActivity?.currentFocus;
  const entries = detail.currentActivity?.entries ?? [];
  if (typeof focus === "string" && focus) {
    console.log("");
    console.log(`Current focus: ${truncate(focus, 160)}`);
  }
  if (entries.length > 0) {
    console.log("");
    console.log("Latest narration (newest first):");
    for (const entry of entries) {
      const at = entry.timestamp ? `[${formatDate(entry.timestamp)}] ` : "";
      console.log(`  ${at}${truncate(entry.message, 160)}`);
    }
  }

  const pullRequests = detail.pullRequests ?? [];
  if (pullRequests.length > 0) {
    console.log("");
    console.log("Pull requests:");
    for (const pr of pullRequests) {
      console.log(`  #${pr.number} ${pr.role}${pr.state ? ` (${pr.state})` : ""}${pr.taskId ? ` task ${pr.taskId}` : ""}`);
    }
  }
  console.log("=".repeat(60));
}

interface FailureContext {
  command: string;
  json?: boolean;
  goalId?: string;
  idempotencyKey?: string;
}

function failureCode(error: unknown, command: string): { code: GoalFailureCode; status?: number } {
  if (error instanceof GoalUsageError || error instanceof ProjectResolutionError) return { code: "invalid_arguments" };
  if (error instanceof GoalMutationUncertainError) return { code: "outcome_uncertain" };
  const classification = classifyApiError(error);
  const status = classification.status;
  if (classification.kind === "unauthorized") return { code: "unauthorized", status };
  if (classification.kind === "forbidden") return { code: "forbidden", status };
  if (status === 400) return { code: "validation_failed", status };
  if (status === 404) return { code: "not_found", status };
  if (status === 409) {
    if (/idempotency-key/i.test(classification.message)) return { code: "idempotency_conflict", status };
    if (command === "create") return { code: "agent_not_goal_capable", status };
    return { code: "state_conflict", status };
  }
  if (status !== undefined && status >= 500) return { code: "server_error", status };
  if (error instanceof ApiError && status === 0) return { code: "network_error" };
  if (error instanceof ApiError) return { code: "request_failed", status };
  return { code: "invalid_arguments" };
}

function recoveryHint(error: unknown, context: FailureContext, code: GoalFailureCode): string | null {
  if (code === "outcome_uncertain" && error instanceof GoalMutationUncertainError) {
    const rerun = error.refusal?.status === 401
      ? "After 'propr login', re-run"
      : error.refusal ? "Once access is restored, re-run" : "Re-run";
    return context.command === "create"
      ? `The goal may already have been created. ${rerun} the same command with --idempotency-key ${error.idempotencyKey} to recover it without starting another goal, or check 'propr goal list'.`
      : `The request may already have been accepted. ${rerun} the same command with --idempotency-key ${error.idempotencyKey}; it will not be applied twice.`;
  }
  if (code === "idempotency_conflict") return "Use a new --idempotency-key for a different request, or repeat the original request exactly.";
  return null;
}

/** Prints a failure (JSON document on stdout with --json, message on stderr otherwise) and exits 1. */
function fail(error: unknown, context: FailureContext): never {
  const { code, status } = failureCode(error, context.command);
  const message = error instanceof Error ? error.message : String(error);
  const idempotencyKey = error instanceof GoalMutationUncertainError ? error.idempotencyKey : context.idempotencyKey;
  const refusal = error instanceof GoalMutationUncertainError && error.refusal
    ? { code: failureCode(error.refusal, context.command).code, status: error.refusal.status }
    : null;
  const recovery = recoveryHint(error, context, code);
  if (context.json) {
    printJson({
      kind: "goal-error",
      command: context.command,
      error: {
        code,
        message,
        status: status ?? refusal?.status ?? null,
        ...(refusal ? { refusal } : {}),
        ...(context.goalId ? { goalId: context.goalId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(error instanceof GoalMutationUncertainError ? { attempts: error.attempts } : {}),
        recovery,
      },
    });
  } else if (code === "unauthorized") {
    console.error(LOGIN_REQUIRED_ERROR);
  } else if (code === "forbidden") {
    console.error(`Error: Access denied. ${message}`);
  } else if (code === "not_found" && context.goalId) {
    console.error(`Error: Goal not found: ${context.goalId}`);
  } else if (code === "outcome_uncertain") {
    console.error(`Error: Could not confirm the outcome (${message}).`);
    if (refusal) console.error(refusal.code === "unauthorized" ? LOGIN_REQUIRED_ERROR : "Error: Access denied.");
  } else {
    console.error(`Error: ${message}`);
  }
  if (!context.json && recovery) console.error(recovery);
  process.exit(1);
}

/**
 * Command whose parser failures (missing arguments or option values, unknown
 * options, excess arguments) honour the `--json` error contract. Commander
 * rejects these before any action runs, so `fail` never sees them.
 */
class GoalCommand extends Command {
  private parsedArgv: string[] = [];

  override createCommand(name?: string): Command {
    return new GoalCommand(name);
  }

  override parseOptions(argv: string[]): ParseOptionsResult {
    this.parsedArgv = argv;
    return super.parseOptions(argv);
  }

  private jsonRequested(): boolean {
    const end = this.parsedArgv.indexOf("--");
    const tokens = end === -1 ? this.parsedArgv : this.parsedArgv.slice(0, end);
    return Boolean(this.opts().json) || tokens.some((token) => token === "--json" || token === "-j");
  }

  override error(message: string, errorOptions?: ErrorOptions): never {
    if (!this.jsonRequested()) return super.error(message, errorOptions);
    const usage = this.parent ? `propr goal ${this.name()} --help` : "propr goal --help";
    printJson({
      kind: "goal-error",
      command: this.name(),
      error: {
        code: "invalid_arguments" satisfies GoalFailureCode,
        message: message.replace(/^error:\s*/i, ""),
        status: null,
        recovery: `Run '${usage}' for usage.`,
      },
    });
    // Keep Commander's exit code and exitOverride handling; only replace its plain-text message.
    const output = { ...this.configureOutput() };
    this.configureOutput({ ...output, outputError: () => {} });
    try {
      return super.error(message, errorOptions);
    } finally {
      this.configureOutput(output);
    }
  }
}

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new GoalUsageError(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function parseBoundedInteger(value: string, name: string, min: number, max: number): number {
  let parsed: number;
  try {
    parsed = parsePositiveInteger(value, name);
  } catch (error) {
    throw new GoalUsageError((error as Error).message);
  }
  if (parsed < min || parsed > max) throw new GoalUsageError(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function parseIdempotencyKey(value: string | undefined): string {
  try {
    return resolveIdempotencyKey(value);
  } catch (error) {
    throw new GoalUsageError((error as Error).message);
  }
}

function findAgent(agents: GoalCapabilityAgent[], selector: string): GoalCapabilityAgent | undefined {
  return agents.find((agent) => agent.agentId === selector) ?? agents.find((agent) => agent.agentAlias === selector);
}

/** Fills an omitted agent (when exactly one is goal-capable) or model (agent default) from capabilities. */
async function resolveAgentAndModel(agent: string | undefined, model: string | undefined): Promise<{ agentId: string; model: string }> {
  if (agent && model) return { agentId: agent, model };
  const capabilities = await getGoalCapabilities();
  let selected: GoalCapabilityAgent | undefined;
  if (agent) {
    selected = findAgent(capabilities, agent);
    if (!selected) throw new GoalUsageError(`Agent "${agent}" is not configured. Run 'propr goal capabilities' to list goal-capable agents.`);
  } else {
    const capable = capabilities.filter((item) => item.goalCapable);
    if (capable.length !== 1) {
      throw new GoalUsageError(capable.length === 0
        ? "No configured agent currently supports goals. Run 'propr goal capabilities' for the reasons."
        : `Choose an agent with --agent (goal-capable: ${capable.map((item) => item.agentAlias).join(", ")}).`);
    }
    selected = capable[0];
  }
  const resolvedModel = model ?? selected.defaultModel;
  if (!resolvedModel) throw new GoalUsageError(`Agent "${selected.agentAlias}" has no default model; pass --model.`);
  return { agentId: selected.agentId, model: resolvedModel };
}

function mutationNote(action: string, goal: Goal | null, extra?: string): string {
  const parts = [`${action} accepted.`];
  if (goal?.control?.pending) parts.push("The provider has not acknowledged it yet; it applies at the next provider boundary.");
  if (extra) parts.push(extra);
  return parts.join(" ");
}

interface ControlSpec {
  action: "pause" | "resume" | "cancel";
  run: (goalId: string, key: string) => Promise<GoalMutationResult>;
  requested: Record<string, unknown>;
  confirmed: (goal: Goal) => boolean;
  pendingMessage: string;
  confirmedMessage: string;
}

const CONTROL_SPECS: ControlSpec[] = [
  {
    action: "pause",
    run: (goalId, key) => pauseGoal(goalId, key),
    requested: { desiredState: "paused" },
    confirmed: (goal) => goal.desiredState === "paused" && !goal.pausePending,
    pendingMessage: "Pause requested; the provider has not confirmed it yet.",
    confirmedMessage: "Goal is paused.",
  },
  {
    action: "resume",
    run: (goalId, key) => resumeGoal(goalId, key),
    requested: { desiredState: "running" },
    confirmed: (goal) => observedGoalState(goal) === "running",
    pendingMessage: "Resume requested; the goal continues once the provider picks it up.",
    confirmedMessage: "Goal is running.",
  },
  {
    action: "cancel",
    run: (goalId, key) => cancelGoal(goalId, key),
    requested: { desiredState: "cancelled" },
    confirmed: (goal) => goal.resultState === "cancelled",
    pendingMessage: "Cancellation requested; execution has not confirmed it stopped yet.",
    confirmedMessage: "Goal is cancelled.",
  },
];

function addControlCommand(goal: Command, spec: ControlSpec): void {
  goal
    .command(`${spec.action} <goal-id>`)
    .description(`Request to ${spec.action} a goal (acceptance is not provider confirmation)`)
    .option("--idempotency-key <key>", "Reuse a key to retry this exact request safely")
    .option("-j, --json", "Output the version 1 goal-control JSON document")
    .addHelpText("after", `
The JSON result separates the request from confirmation:
  { "version": 1, "kind": "goal-control", "action": "${spec.action}", "accepted": true,
    "requested": {...}, "confirmed": boolean, "goal": {...} }
`)
    .action(async (goalId: string, options: { idempotencyKey?: string; json?: boolean }) => {
      let key: string | undefined;
      try {
        key = parseIdempotencyKey(options.idempotencyKey);
        const result = await spec.run(goalId, key);
        const confirmed = result.goal ? spec.confirmed(result.goal) : false;
        if (options.json) {
          printJson({
            kind: "goal-control",
            action: spec.action,
            goalId,
            idempotencyKey: result.idempotencyKey,
            attempts: result.attempts,
            accepted: true,
            requested: spec.requested,
            confirmed,
            goal: result.goal ? goalJson(result.goal) : null,
          });
          return;
        }
        console.log(confirmed ? spec.confirmedMessage : spec.pendingMessage);
        if (result.goal) printGoalSummary(result.goal);
        console.log(`Idempotency key: ${result.idempotencyKey}`);
      } catch (error) {
        fail(error, { command: spec.action, json: options.json, goalId, idempotencyKey: key });
      }
    });
}

/**
 * Creates the `goal` command group.
 */
export function createGoalCommand(): Command {
  const goal = new GoalCommand("goal")
    .description("Create, inspect, steer, pause, resume, cancel and re-model long-running goals")
    .addHelpText("after", `
A goal is an objective that an agent pursues autonomously until it opens a
pull request. 'propr goal create' starts work immediately.

Every command accepts --json and prints a { "version": 1, "kind": ... }
document. Failures exit 1; with --json they print a "goal-error" document with
a machine-readable error.code. Mutations accept --idempotency-key; retrying
with the same key never starts a second goal or queues a second input.

Examples:
  $ propr goal capabilities
  $ propr goal create -p myorg/myrepo --agent codex --model <model> "Add rate limiting to the API"
  $ propr goal list --state active
  $ propr goal inspect <goal-id>
  $ propr goal input <goal-id> "Also cover the admin endpoints"
  $ propr goal inputs <goal-id>
  $ propr goal pause <goal-id>
  $ propr goal resume <goal-id>
  $ propr goal model <goal-id> <model>
  $ propr goal cancel <goal-id>
`);

  goal
    .command("capabilities")
    .description("Show which configured agents support goals, their models, and why others cannot run them")
    .option("--recheck", "Re-probe agent runtimes instead of using cached capability results")
    .option("-j, --json", "Output the version 1 goal-capabilities JSON document")
    .action(async (options: { recheck?: boolean; json?: boolean }) => {
      try {
        const agents = await getGoalCapabilities(options.recheck ?? false);
        if (options.json) {
          printJson({ kind: "goal-capabilities", agents });
          return;
        }
        if (agents.length === 0) {
          console.log("No agents are configured. Add one with 'propr agent add'.");
          return;
        }
        printTable([
          { heading: "Agent", values: agents.map((agent) => agent.agentAlias) },
          { heading: "Type", values: agents.map((agent) => agent.agentType) },
          { heading: "Goals", values: agents.map((agent) => (agent.goalCapable ? "supported" : "unavailable")) },
          { heading: "Default model", values: agents.map((agent) => agent.defaultModel ?? "-") },
          { heading: "Models", values: agents.map((agent) => truncate(agent.models.join(", "), 40) || "-") },
        ]);
        const unavailable = agents.filter((agent) => !agent.goalCapable);
        if (unavailable.length > 0) {
          console.log("");
          for (const agent of unavailable) {
            console.log(`${agent.agentAlias}: ${agent.reason ?? "does not support the goal/session contract"}`);
          }
        }
      } catch (error) {
        fail(error, { command: "capabilities", json: options.json });
      }
    });

  goal
    .command("create [objective...]")
    .description("Create a goal and START autonomous work on it")
    .option("-p, --project <project>", "Target repository (owner/repo); defaults to the configured project")
    .option("-f, --file <path>", "Read the objective from a file")
    .option("--stdin", "Read the objective from standard input")
    .option("-a, --agent <agent>", "Agent ID or alias (defaults to the only goal-capable agent)")
    .option("-m, --model <model>", "Model (defaults to the agent's default model)")
    .option("-s, --strategy <strategy>", "Launch strategy: direct or orchestrate", "direct")
    .option("-b, --base-branch <branch>", "Base branch for the goal's pull request")
    .option("--max-parallel-tasks <n>", "Maximum parallel tasks (1-32)")
    .option("--checkpoint-interval <minutes>", "Checkpoint interval in minutes, validated by the server (direct strategy only; default 15)")
    .option("--ultrafix", "Have the agent run Ultrafix before it declares the goal complete")
    .option("--idempotency-key <key>", "Reuse a key to retry or recover this exact creation without starting another goal")
    .option("-j, --json", "Output the version 1 goal-create JSON document")
    .addHelpText("after", `
Creating a goal starts work immediately: the agent begins pursuing the
objective as soon as it is queued.

The objective must come from exactly one source: the argument, --file, or --stdin.

If the response is lost (network error, timeout), the command prints the
idempotency key it used. Re-running with --idempotency-key <key> returns the
goal that was created instead of starting another one.

JSON:
  { "version": 1, "kind": "goal-create", "outcome": "created" | "replayed" | "saved_queue_pending",
    "workStarted": boolean, "goalId": "...", "idempotencyKey": "...", "goal": {...} }

Examples:
  $ propr goal create -p myorg/myrepo -a codex -m <model> "Migrate the billing module to the new API"
  $ propr goal create --file objective.md --strategy orchestrate --max-parallel-tasks 3
  $ cat objective.md | propr goal create --stdin --checkpoint-interval 30 --json
`)
    .action(async (objectiveArg: string[] | undefined, options: {
      project?: string; file?: string; stdin?: boolean; agent?: string; model?: string; strategy: string;
      baseBranch?: string; maxParallelTasks?: string; checkpointInterval?: string; ultrafix?: boolean;
      idempotencyKey?: string; json?: boolean;
    }) => {
      let key: string | undefined;
      try {
        key = parseIdempotencyKey(options.idempotencyKey);
        const strategy = options.strategy.toLowerCase();
        if (!(GOAL_LAUNCH_STRATEGIES as readonly string[]).includes(strategy)) {
          throw new GoalUsageError(`Invalid strategy "${options.strategy}". Expected one of: ${GOAL_LAUNCH_STRATEGIES.join(", ")}.`);
        }
        if (options.checkpointInterval !== undefined && strategy !== "direct") {
          throw new GoalUsageError("--checkpoint-interval only applies to the direct strategy.");
        }
        let objective: string | undefined;
        try {
          objective = (await resolveTextInput(objectiveArg, options))?.trim();
        } catch (error) {
          throw new GoalUsageError((error as Error).message);
        }
        if (!objective) throw new GoalUsageError("An objective is required via an argument, --file, or --stdin.");
        const configManager = await createConfigManager();
        const repository = resolveProject(options, configManager);
        const request: CreateGoalRequest = {
          repository,
          objective,
          ...await resolveAgentAndModel(options.agent, options.model),
          launchStrategy: strategy as GoalLaunchStrategy,
          ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
          ...(options.maxParallelTasks !== undefined
            ? { maxParallelTasks: parseBoundedInteger(options.maxParallelTasks, "--max-parallel-tasks", 1, 32) }
            : {}),
          ...(options.checkpointInterval !== undefined
            ? { checkpointIntervalMinutes: parseBoundedInteger(options.checkpointInterval, "--checkpoint-interval", 1, Number.MAX_SAFE_INTEGER) }
            : {}),
          ...(options.ultrafix ? { ultrafix: true } : {}),
        };
        const result = await createGoal(request, key);
        const workStarted = result.outcome !== "saved_queue_pending";
        if (options.json) {
          printJson({
            kind: "goal-create",
            outcome: result.outcome,
            workStarted,
            goalId: result.goalId,
            idempotencyKey: result.idempotencyKey,
            attempts: result.attempts,
            goal: result.goal ? goalJson(result.goal) : null,
          });
          return;
        }
        if (result.outcome === "created") console.log("Goal created and started.");
        else if (result.outcome === "replayed") console.log("This idempotency key already created a goal; no new goal was started.");
        else console.log("Goal was saved, but its first attempt is not queued yet. The server's recovery will start it; no new goal is needed.");
        if (result.goal) printGoalSummary(result.goal);
        else console.log(`Goal:        ${result.goalId}`);
        console.log(`Idempotency key: ${result.idempotencyKey}`);
        console.log("");
        console.log(`Inspect it with: propr goal inspect ${result.goalId}`);
      } catch (error) {
        fail(error, { command: "create", json: options.json, idempotencyKey: key });
      }
    });

  goal
    .command("list")
    .description("List your goals with optional repository and lifecycle filters")
    .option("-p, --project <project>", "Filter by repository (owner/repo)")
    .option("-s, --state <state>", `Lifecycle filter: ${GOAL_LIST_STATES.join(", ")}`, "all")
    .option("-l, --limit <limit>", "Page size (1-200)", "20")
    .option("--offset <offset>", "Number of goals to skip", "0")
    .option("-j, --json", "Output the version 1 goal-list JSON document")
    .addHelpText("after", `
States:
  active      Every goal that has not reached a terminal result
  running     Active goals requested to run
  paused      Active goals requested to pause
  completed   Goals whose objective was completed
  failed      Goals that failed
  cancelled   Goals that were cancelled
  all         Everything (default)

Pages are ordered newest first. When more goals exist, the output gives the
next --offset (JSON: "nextOffset"; null on the last page).
`)
    .action(async (options: { project?: string; state: string; limit: string; offset: string; json?: boolean }) => {
      try {
        const state = options.state.toLowerCase();
        if (!(GOAL_LIST_STATES as readonly string[]).includes(state)) {
          throw new GoalUsageError(`Invalid state "${options.state}". Expected one of: ${GOAL_LIST_STATES.join(", ")}.`);
        }
        const repository = resolveOptionalProject(options);
        const limit = parseBoundedInteger(options.limit, "--limit", 1, 200);
        const offset = parseNonNegativeInteger(options.offset, "--offset");
        const page = await listGoals({ repository, state: state as GoalListState, offset, limit });
        if (options.json) {
          printJson({
            kind: "goal-list",
            filters: { repository: repository ?? null, state },
            offset: page.offset,
            limit: page.limit,
            nextOffset: page.nextOffset,
            goals: page.goals.map(goalJson),
          });
          return;
        }
        if (page.goals.length === 0) {
          console.log("No goals found.");
          return;
        }
        printTable([
          { heading: "ID", values: page.goals.map((item) => item.id) },
          { heading: "Repository", values: page.goals.map((item) => truncate(item.repository, 28)) },
          { heading: "Title", values: page.goals.map((item) => truncate(item.title, 32)) },
          { heading: "State", values: page.goals.map((item) => stateLine(item)) },
          { heading: "Agent / Model", values: page.goals.map((item) => truncate(`${item.agent.alias} / ${item.effectiveModel ?? item.requestedModel}`, 30)) },
          { heading: "PR", values: page.goals.map((item) => (item.finalPr?.number ? `#${item.finalPr.number}` : "-")) },
          { heading: "Updated", values: page.goals.map((item) => formatDate(item.updatedAt)) },
        ]);
        console.log("");
        console.log(`Showing ${page.goals.length} goal(s) from offset ${page.offset}.`);
        if (page.nextOffset !== null) console.log(`More goals: --offset ${page.nextOffset}`);
      } catch (error) {
        fail(error, { command: "list", json: options.json });
      }
    });

  goal
    .command("attention")
    .description("List goals waiting on you: confirmed pauses and explicit provider questions or approvals")
    .option("-p, --project <project>", "Filter by repository (owner/repo)")
    .option("-l, --limit <limit>", "Page size (1-100)", "20")
    .option("--offset <offset>", "Number of goals to skip", "0")
    .option("-j, --json", "Output the version 1 goal-attention JSON document")
    .addHelpText("after", `
Only explicit signals are listed: a confirmed pause, or a structured provider
question or approval. Silence, slow work and queued corrections never are.
Each blocker names the supported command that resolves it. Sending input queues
an answer; the blocker clears only when the provider confirms it.
`)
    .action(async (options: { project?: string; limit: string; offset: string; json?: boolean }) => {
      try {
        const repository = resolveOptionalProject(options);
        const limit = parseBoundedInteger(options.limit, "--limit", 1, 100);
        const offset = parseNonNegativeInteger(options.offset, "--offset");
        const page = await listGoalAttention({ repository, offset, limit });
        if (options.json) {
          printJson({
            kind: "goal-attention",
            filters: { repository: repository ?? null },
            offset: page.offset,
            limit: page.limit,
            nextOffset: page.nextOffset,
            goals: page.goals,
          });
          return;
        }
        if (page.goals.length === 0) {
          // A page can empty out while a later page still holds blockers;
          // only an exhausted listing means nothing is waiting.
          if (page.nextOffset === null) {
            console.log("No goals are waiting on you.");
          } else {
            console.log(`No goals on this page are waiting on you. More goals: --offset ${page.nextOffset}`);
          }
          return;
        }
        for (const entry of page.goals as GoalAttentionEntry[]) {
          console.log(`${entry.goalId}  ${entry.repository}  ${truncate(entry.title ?? "", 48)}`);
          printBlockers(entry.goalId, entry.blockers);
        }
        console.log("");
        if (page.nextOffset !== null) console.log(`More goals: --offset ${page.nextOffset}`);
      } catch (error) {
        fail(error, { command: "attention", json: options.json });
      }
    });

  goal
    .command("inspect <goal-id>")
    .description("Show a goal's requested and observed state, narration, progress, checkpoints, inputs, model, failures and PRs")
    .option("-j, --json", "Output the version 1 goal-detail JSON document")
    .addHelpText("after", `
JSON:
  { "version": 1, "kind": "goal-detail", "goal": {
      "lifecycle": { "requestedState", "observedState", "resultState", "goalCompleted", ... },
      "model": { "requested", "effective", "confirmed" },
      "currentTask": { "id", "state", "taskCompleted" },
      "narration", "progress", "pendingInput", "checkpoint", "failure", "finalPr", "pullRequests", ... } }

"goalCompleted" reflects the goal's result; "taskCompleted" only reflects the
current provider task and does not mean the goal is done.
`)
    .action(async (goalId: string, options: { json?: boolean }) => {
      try {
        const { goal: item, detail } = await getGoalDetail(goalId);
        if (options.json) {
          printJson({ kind: "goal-detail", goal: goalDetailJson(item, detail) });
          return;
        }
        printGoalDetail(item, detail);
      } catch (error) {
        fail(error, { command: "inspect", json: options.json, goalId });
      }
    });

  goal
    .command("input <goal-id> [message...]")
    .description("Send a correction or question to a goal (queued for the next provider boundary)")
    .option("-f, --file <path>", "Read the message from a file")
    .option("--stdin", "Read the message from standard input")
    .option("--canned <request>", "Send a canned status request: done (\"What's done?\") or left (\"What's left?\")")
    .option("--idempotency-key <key>", "Reuse a key to retry this exact input without queueing it twice")
    .option("-j, --json", "Output the version 1 goal-input JSON document")
    .addHelpText("after", `
The message must come from exactly one source: the argument, --file, --stdin,
or --canned.

Acceptance means the input was durably queued. "delivered" means ProPR handed
it to the provider; neither proves the agent has acted on it. Check
'propr goal inputs <goal-id>' and 'propr goal inspect <goal-id>'.

Examples:
  $ propr goal input <goal-id> "Use the existing retry helper instead of a new one"
  $ propr goal input <goal-id> --file correction.md
  $ propr goal input <goal-id> --canned left
`)
    .action(async (goalId: string, messageArg: string[] | undefined, options: {
      file?: string; stdin?: boolean; canned?: string; idempotencyKey?: string; json?: boolean;
    }) => {
      let key: string | undefined;
      try {
        key = parseIdempotencyKey(options.idempotencyKey);
        let payload: { message: string } | { canned: CannedInput };
        let expectedMessage: string;
        if (options.canned !== undefined) {
          if (!(options.canned in CANNED_INPUTS)) throw new GoalUsageError("--canned must be done or left.");
          if ((messageArg?.length ?? 0) > 0 || options.file || options.stdin) {
            throw new GoalUsageError("Use --canned without a message argument, --file, or --stdin.");
          }
          payload = { canned: options.canned as CannedInput };
          expectedMessage = CANNED_INPUTS[options.canned as CannedInput];
        } else {
          let message: string | undefined;
          try {
            message = (await resolveTextInput(messageArg, options))?.trim();
          } catch (error) {
            throw new GoalUsageError((error as Error).message);
          }
          if (!message) throw new GoalUsageError("A message is required via an argument, --file, --stdin, or --canned.");
          payload = { message };
          expectedMessage = message;
        }
        const result = await sendGoalInput(goalId, payload, key);
        const input = [...(result.goal?.inputs ?? [])].reverse().find((item) => item.message === expectedMessage) ?? null;
        if (options.json) {
          printJson({
            kind: "goal-input",
            goalId,
            idempotencyKey: result.idempotencyKey,
            attempts: result.attempts,
            accepted: true,
            input: input ? inputJson(input) : null,
            goal: result.goal ? goalJson(result.goal) : null,
          });
          return;
        }
        const delivery = input?.state === "delivered"
          ? "It has been delivered to the provider; that does not mean the agent has acted on it yet."
          : "It is queued for the next provider boundary and has not been delivered yet.";
        console.log(mutationNote("Input", null, delivery));
        if (input) console.log(`Input ID:        ${input.id}`);
        console.log(`Idempotency key: ${result.idempotencyKey}`);
      } catch (error) {
        fail(error, { command: "input", json: options.json, goalId, idempotencyKey: key });
      }
    });

  goal
    .command("inputs <goal-id>")
    .description("Show the delivery history of inputs sent to a goal, newest first")
    .option("-l, --limit <limit>", "Page size (1-100)", "20")
    .option("--offset <offset>", "Number of inputs to skip", "0")
    .option("-j, --json", "Output the version 1 goal-inputs JSON document")
    .addHelpText("after", `
States:
  pending        Queued; not yet handed to the provider
  delivered      Handed to the provider (not proof the agent acted on it)
  undeliverable  Could not be delivered
`)
    .action(async (goalId: string, options: { limit: string; offset: string; json?: boolean }) => {
      try {
        const limit = parseBoundedInteger(options.limit, "--limit", 1, 100);
        const offset = parseNonNegativeInteger(options.offset, "--offset");
        const page = await listGoalInputs(goalId, { offset, limit });
        if (options.json) {
          printJson({
            kind: "goal-inputs",
            goalId,
            order: page.order ?? "newest_first",
            offset: page.offset,
            limit: page.limit,
            nextOffset: page.nextOffset,
            inputs: page.inputs.map(inputJson),
          });
          return;
        }
        if (page.inputs.length === 0) {
          console.log("No inputs have been sent to this goal.");
          return;
        }
        printTable([
          { heading: "ID", values: page.inputs.map((input) => input.id) },
          { heading: "State", values: page.inputs.map((input) => input.state) },
          { heading: "Sent", values: page.inputs.map((input) => formatDate(input.createdAt)) },
          { heading: "Delivered", values: page.inputs.map((input) => formatDate(input.deliveredAt)) },
          { heading: "Message", values: page.inputs.map((input) => truncate(input.message, 60)) },
        ]);
        if (page.nextOffset !== null) {
          console.log("");
          console.log(`More inputs: --offset ${page.nextOffset}`);
        }
      } catch (error) {
        fail(error, { command: "inputs", json: options.json, goalId });
      }
    });

  for (const spec of CONTROL_SPECS) addControlCommand(goal, spec);

  goal
    .command("model <goal-id> <model>")
    .description("Request a model change for a goal (applied at the next provider boundary)")
    .option("--idempotency-key <key>", "Reuse a key to retry this exact request safely")
    .option("-j, --json", "Output the version 1 goal-control JSON document")
    .addHelpText("after", `
The model must be supported by the goal's agent. The change is requested
immediately and confirmed once the provider runs with it: compare
goal.model.requested with goal.model.effective (JSON "confirmed").
`)
    .action(async (goalId: string, model: string, options: { idempotencyKey?: string; json?: boolean }) => {
      let key: string | undefined;
      try {
        key = parseIdempotencyKey(options.idempotencyKey);
        const result = await setGoalModel(goalId, model, key);
        const confirmed = result.goal?.effectiveModel === model && !result.goal.control?.pending;
        if (options.json) {
          printJson({
            kind: "goal-control",
            action: "model",
            goalId,
            idempotencyKey: result.idempotencyKey,
            attempts: result.attempts,
            accepted: true,
            requested: { model },
            confirmed,
            goal: result.goal ? goalJson(result.goal) : null,
          });
          return;
        }
        console.log(confirmed
          ? `Goal is running with ${model}.`
          : `Model change to ${model} requested; it applies at the next provider boundary.`);
        if (result.goal) printGoalSummary(result.goal);
        console.log(`Idempotency key: ${result.idempotencyKey}`);
      } catch (error) {
        fail(error, { command: "model", json: options.json, goalId, idempotencyKey: key });
      }
    });

  return goal;
}
