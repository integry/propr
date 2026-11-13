/**
 * Admission Command
 *
 * `propr admission` prints what physical agent-run admission enforces right
 * now, globally and per agent, as a table (or `--json`), followed by the other
 * limits a scheduler must respect. This is not subscription usage; see
 * `propr tank` for provider quota.
 */

import { Command } from "commander";
import { getAgentRunAdmission, type AgentRunAdmissionReport } from "../api/index.js";
import { printOutput } from "../utils/index.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

export const ADMISSION_HEADERS = [
  "Agent", "Ceiling", "In use", "Running", "Reserved", "Recovering", "Draining", "Nested", "Wait global", "Wait ceiling", "Wait other", "Deferred",
];

const ceilingCell = (ceiling: number | null): string => ceiling === null ? "—" : String(ceiling);

/** One row for all agents (the global limit), then one per agent alias. */
export function formatAdmissionRows(report: AgentRunAdmissionReport): string[][] {
  const global = report.admission.global;
  if (!global) return [];
  const rows: string[][] = [[
    "(global)", String(global.limit), String(global.inUse), String(global.holders.running), String(global.holders.reserved),
    String(global.holders.recovering), String(global.holders.draining), String(global.nested.total),
    String(global.waiting.globalLimit), String(global.waiting.agentCeiling), String(global.waiting.recovering + global.waiting.starting),
    String(global.deferred),
  ]];
  for (const agent of report.agents) {
    rows.push([
      agent.alias, ceilingCell(agent.ceiling), String(agent.inUse), String(agent.holders.running), String(agent.holders.reserved),
      String(agent.holders.recovering), String(agent.holders.draining), String(agent.nested.total),
      String(agent.waiting.globalLimit), String(agent.waiting.agentCeiling), String(agent.waiting.recovering + agent.waiting.starting),
      String(agent.deferred),
    ]);
  }
  return rows;
}

function table(headers: string[], rows: string[][]): string[] {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map(row => row[column].length)));
  const line = (row: string[]) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ").trimEnd();
  return [line(headers), widths.map(width => "-".repeat(width)).join("  "), ...rows.map(line)];
}

const known = (value: number | null): string => value === null ? "unknown" : String(value);

/** The human-readable report, as lines. */
export function formatAdmissionReport(report: AgentRunAdmissionReport): string[] {
  const lines: string[] = [`Agent-run admission · as of ${report.asOf}`, ""];
  const { admission } = report;
  if (!admission.enabled) {
    lines.push("Admission is off: no instance-wide agent-run limit or per-agent ceilings are enforced.");
    lines.push("Set PROPR_AGENT_RUN_LIMIT and PROPR_INSTANCE_ID to enable it (Hosted: the Fleet entitlement).");
  } else if (!admission.global) {
    lines.push(`Admission is on, but its state is unavailable: ${admission.unavailable ?? "unknown reason"}.`);
  } else {
    const global = admission.global;
    const source = global.limitSource === "hosted_entitlement" ? "Hosted entitlement" : global.limitSource;
    const nestedSource = global.nestedLimitSource === "default" ? "default" : global.nestedLimitSource;
    lines.push(`Global limit ${global.limit} (${source}) · generation ${global.generation} · nested executions per parent ${global.nestedLimit} (${nestedSource})`);
    if (!admission.agentCeilingsConfigured) lines.push("No per-agent ceilings (PROPR_AGENT_RUN_ALIAS_LIMITS unset): agents share the global limit.");
    lines.push("");
    lines.push(...table(ADMISSION_HEADERS, formatAdmissionRows(report)));
    lines.push("");
    lines.push("In use: holders compared with the limit or ceiling. Nested: executions charged under a parent, shown apart from holders.");
    lines.push("Wait global / Wait ceiling: launches waiting at the boundary on the global limit or the agent's ceiling. Deferred: queue jobs delayed until the agent has capacity.");
    if (global.unattributedHolders) lines.push(`${global.unattributedHolders} holder(s) carry no agent alias (pre-upgrade or exempt launches) and count toward the global limit only.`);
    const tasks = report.agents.flatMap(agent => agent.tasks.map(task => ({ ...task, alias: agent.alias })));
    if (tasks.length) {
      lines.push("", "Tasks:");
      for (const task of tasks) {
        const state = task.state === "waiting" ? `waiting (${task.waitReason ?? "starting"})` : task.state;
        lines.push(`  ${task.alias}  ${state}${task.nested ? " nested" : ""}  ${task.taskId}`);
      }
    }
  }
  const workers = report.queueWorkers;
  lines.push("", `Queue workers: ${known(workers.inUse)} of ${known(workers.total)} job slots in use across ${known(workers.workers)} worker(s).`);
  lines.push(`  ${workers.label}`);
  const slots = report.repositoryWorkflowSlots;
  lines.push("", `Repository workflow slots: ${slots.repositories.length ? "" : "none in use under a limit."}`.trimEnd());
  for (const slot of slots.repositories) lines.push(`  ${slot.repository}  ${slot.inUse}/${slot.limit} in use, ${slot.waiting} waiting`);
  lines.push(`  ${slots.label}`);
  lines.push("", report.subscriptionUsage);
  return lines;
}

export function createAdmissionCommand(): Command {
  return new Command("admission")
    .description("Show agent-run admission: the global limit, per-agent ceilings, and what is running, waiting and deferred")
    .option("--json", "Output raw JSON response")
    .addHelpText("after", `
Examples:
  $ propr admission
  $ propr admission --json

This is not subscription usage; see 'propr tank' for provider quota.
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const report = await getAgentRunAdmission();
        if (printOutput(report, options.json ?? false)) return;
        for (const line of formatAdmissionReport(report)) console.log(line);
      } catch (error) {
        presentApiError(error, {
          forbiddenMessage: "Error: Access denied. You do not have permission to view agent-run admission.",
          fallbackMessage: `Error fetching agent-run admission: ${(error as Error).message}`,
        });
        process.exit(1);
      }
    });
}
