import { Command } from "commander";
import {
  AGENT_SKILL_TARGETS,
  inspectAgentSkills,
  installAgentSkills,
  parseAgentSkillTargets,
  removeAgentSkills,
  type AgentSkillOperationResult,
  type AgentSkillStatus,
} from "../agentSkill.js";

interface OutputOptions {
  json?: boolean;
  force?: boolean;
}

function identity(value: string | undefined): string {
  return value ?? "-";
}

export function formatAgentSkillStatus(status: AgentSkillStatus): string {
  const installed = status.installedIdentity ? ` installed=${identity(status.installedIdentity)}` : "";
  const detail = status.detail ? ` (${status.detail})` : "";
  return `${status.target.padEnd(12)} ${status.state.padEnd(19)} ${status.path} bundled=${identity(status.bundledIdentity)}${installed}${detail}`;
}

export function formatAgentSkillOperation(result: AgentSkillOperationResult): string {
  const detail = result.detail ? `: ${result.detail}` : "";
  const backup = result.backupPath ? `; backup: ${result.backupPath}` : "";
  return `${result.target}: ${result.action} ${result.path}${detail}${backup}`;
}

function hasFailure(results: readonly AgentSkillOperationResult[]): boolean {
  return results.some((result) => result.action === "failed" || result.action === "refused");
}

function selectedTargets(values: string[] | undefined, defaultAll = false) {
  return values && values.length > 0
    ? parseAgentSkillTargets(values)
    : defaultAll
      ? [...AGENT_SKILL_TARGETS]
      : parseAgentSkillTargets([]);
}

export function createAgentSkillCommand(): Command {
  const command = new Command("skill")
    .description("Install and manage the bundled ProPR Operator Agent Skill")
    .addHelpText("after", `
Targets and paths:
  codex        \$CODEX_HOME/skills/propr (or ~/.codex/skills/propr)
  claude       ~/.claude/skills/propr
  antigravity  ~/.gemini/antigravity-cli/skills/propr
  opencode     \$XDG_CONFIG_HOME/opencode/skills/propr (or ~/.config/opencode/skills/propr)
  vibe         ~/.vibe/skills/propr

Examples:
  $ propr skill install codex claude
  $ propr skill status
  $ propr skill remove codex
  $ propr skill install all --force
`);

  command
    .command("install <targets...>")
    .description("Install or update the ProPR skill for one or more targets")
    .option("-f, --force", "Back up and replace foreign or user-modified content")
    .option("-j, --json", "Print machine-readable JSON")
    .action((values: string[], options: OutputOptions) => {
      try {
        const results = installAgentSkills(selectedTargets(values), { force: options.force });
        if (options.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach((result) => console.log(formatAgentSkillOperation(result)));
        if (hasFailure(results)) process.exitCode = 1;
      } catch (error) {
        console.error(`Error managing agent skill: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  command
    .command("status [targets...]")
    .description("Report bundled and installed content identity for each target")
    .option("-j, --json", "Print machine-readable JSON")
    .action((values: string[], options: OutputOptions) => {
      try {
        const results = inspectAgentSkills(selectedTargets(values, true));
        if (options.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach((result) => console.log(formatAgentSkillStatus(result)));
      } catch (error) {
        console.error(`Error inspecting agent skill: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  command
    .command("remove <targets...>")
    .description("Remove only ProPR-managed skill copies")
    .option("-f, --force", "Remove the target but preserve it as a timestamped backup")
    .option("-j, --json", "Print machine-readable JSON")
    .action((values: string[], options: OutputOptions) => {
      try {
        const results = removeAgentSkills(selectedTargets(values), { force: options.force });
        if (options.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach((result) => console.log(formatAgentSkillOperation(result)));
        if (hasFailure(results)) process.exitCode = 1;
      } catch (error) {
        console.error(`Error managing agent skill: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  return command;
}
