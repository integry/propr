/**
 * E2E test report generator — writes a markdown report to test/reports/.
 */

import fs from "node:fs";
import path from "node:path";
import { ApiClient } from "../../packages/cli/src/api/client.js";
import { getPlan, listPlanIssues, type Plan } from "../../packages/cli/src/api/plans.js";
import type { ModelTestResult } from "./helpers.js";

interface PlanEntry {
  label: string;
  id: string | null;
  plan: Plan | null;
}

export async function writeReport(opts: {
  repo: string;
  apiUrl: string;
  client: ApiClient;
  planEntries: PlanEntry[];
  modelResults: ModelTestResult[];
}): Promise<string> {
  const { repo, apiUrl, client, planEntries, modelResults } = opts;
  const lines: string[] = [];
  const w = (s = "") => lines.push(s);

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").substring(0, 19);

  w(`# E2E Test Run Report`);
  w(`**Date:** ${now.toISOString()}  `);
  w(`**Repo:** ${repo}  `);
  w(`**API:** ${apiUrl}  `);
  w();

  // --- Plans ---
  w(`## Plans`);
  w();

  for (const p of planEntries) {
    if (!p.id) {
      w(`### ${p.label}\nNot created.\n`);
      continue;
    }
    try {
      const plan = p.plan ?? await getPlan(p.id, client);
      const issues = await listPlanIssues(p.id, client);

      w(`### ${p.label}`);
      w(`- **ID:** \`${p.id}\``);
      w(`- **Name:** ${plan.name || "(untitled)"}`);
      w(`- **Status:** ${plan.status}`);
      w(`- **Prompt:** ${plan.initial_prompt ?? "(none)"}`);
      w(`- **Plan items:** ${(plan.plan_json ?? []).length}, **GitHub issues:** ${issues.length}`);
      w();

      if (issues.length > 0) {
        w(`| Issue | Status | Agent | Model | Task |`);
        w(`|-------|--------|-------|-------|------|`);
        for (const iss of issues) {
          const taskCell = iss.task_id ? `\`${iss.task_id.substring(0, 30)}...\`` : "-";
          w(`| #${iss.issue_number} | ${iss.status} | ${iss.agent_alias ?? "-"} | ${iss.model_name ?? "-"} | ${taskCell} |`);
        }
        w();
      }
    } catch {
      w(`### ${p.label}\n\`${p.id}\` - could not fetch details.\n`);
    }
  }

  // --- Multi-model parallel results ---
  const parallelResults = modelResults.filter((r) => r.testMode === "parallel");
  if (parallelResults.length > 0) {
    w(`## Multi-Model Parallel Implementation`);
    w(`Same issue #${parallelResults[0].issueNumber} implemented by ${parallelResults.length} models simultaneously.`);
    w();
    w(`| Agent | Model | State | Duration | Tokens (in/out) | PR | History | Logs |`);
    w(`|-------|-------|-------|----------|-----------------|-----|---------|------|`);
    for (const r of parallelResults) {
      const dur = r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : "-";
      const tokens = r.inputTokens || r.outputTokens ? `${r.inputTokens} / ${r.outputTokens}` : "-";
      const pr = r.prNumber ? `#${r.prNumber}` : "-";
      w(`| ${r.agent_alias} | ${r.model_name} | **${r.finalState ?? "no task"}** | ${dur} | ${tokens} | ${pr} | ${r.historyCount} | ${r.logCount} |`);
      if (r.failureReason) w(`| | _${r.failureReason.substring(0, 100)}_ | | | | | | |`);
    }
    w();
  }

  // --- Single-model results ---
  const singleResults = modelResults.filter((r) => r.testMode === "single");
  if (singleResults.length > 0) {
    w(`## Single-Model Implementation`);
    w(`Each model implements a separate issue.`);
    w();

    const byAgent = new Map<string, ModelTestResult[]>();
    for (const r of singleResults) {
      const list = byAgent.get(r.agent_alias) ?? [];
      list.push(r);
      byAgent.set(r.agent_alias, list);
    }

    for (const [agent, results] of byAgent) {
      w(`### Agent: ${agent}`);
      w();
      w(`| Model | Issue | State | Duration | Tokens (in/out) | PR | History | Logs |`);
      w(`|-------|-------|-------|----------|-----------------|-----|---------|------|`);
      for (const r of results) {
        const dur = r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : "-";
        const tokens = r.inputTokens || r.outputTokens ? `${r.inputTokens} / ${r.outputTokens}` : "-";
        const pr = r.prNumber ? `#${r.prNumber}` : "-";
        w(`| ${r.model_name} | #${r.issueNumber} | **${r.finalState ?? "no task"}** | ${dur} | ${tokens} | ${pr} | ${r.historyCount} | ${r.logCount} |`);
        if (r.failureReason) w(`| | _${r.failureReason.substring(0, 100)}_ | | | | | | |`);
      }
      w();
    }
  }

  // --- Totals ---
  if (modelResults.length > 0) {
    w(`## Totals`);
    w();

    const total = modelResults.length;
    const withTasks = modelResults.filter((r) => r.taskId).length;
    const completed = modelResults.filter((r) => r.finalState === "completed").length;
    const failed = modelResults.filter((r) => r.finalState === "failed").length;
    const cancelled = modelResults.filter((r) => r.finalState === "cancelled").length;
    const noTask = modelResults.filter((r) => !r.taskId).length;
    const withHistory = modelResults.filter((r) => r.hasHistory).length;
    const withLogs = modelResults.filter((r) => r.hasLogs).length;
    const totalInput = modelResults.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutput = modelResults.reduce((s, r) => s + r.outputTokens, 0);

    w(`| Metric | Value |`);
    w(`|--------|-------|`);
    w(`| Models tested (parallel) | ${parallelResults.length} |`);
    w(`| Models tested (single) | ${singleResults.length} |`);
    w(`| Tasks created | ${withTasks} (${noTask} never picked up) |`);
    w(`| Completed | ${completed} |`);
    w(`| Failed | ${failed} |`);
    if (cancelled > 0) w(`| Cancelled | ${cancelled} |`);
    w(`| With execution history | ${withHistory} / ${withTasks} |`);
    w(`| With LLM logs | ${withLogs} / ${withTasks} |`);
    w(`| Total tokens | ${totalInput} in / ${totalOutput} out / ${totalInput + totalOutput} total |`);
    w();
  }

  // Write file
  const reportsDir = path.join(process.cwd(), "test", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `e2e-${ts}.md`);
  fs.writeFileSync(reportPath, lines.join("\n"), "utf-8");

  const latestPath = path.join(reportsDir, "latest.md");
  try { fs.unlinkSync(latestPath); } catch { /* ignore */ }
  fs.copyFileSync(reportPath, latestPath);

  return reportPath;
}
