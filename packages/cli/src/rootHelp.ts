/**
 * Root help: the "Command Groups" footer of `propr --help` and the
 * `propr help <command...>` command.
 *
 * The footer only decides which group a top-level command belongs to; the
 * subcommands listed for each command are read from the registered command
 * tree, so a new subcommand appears without editing this file. A top-level
 * command missing from {@link COMMAND_GROUPS} is still listed (under "Other"),
 * and `rootHelp.test.ts` fails until it is given a group.
 */

import type { Command } from "commander";

export interface CommandGroupEntry {
  /** Top-level command name. */
  name: string;
  /** Replaces the generated `[sub|sub]` list, e.g. for a command whose argument takes fixed values. */
  detail?: string;
}

export interface CommandGroup {
  label: string;
  commands: CommandGroupEntry[];
  note?: string;
}

const entries = (...names: string[]): CommandGroupEntry[] => names.map((name) => ({ name }));

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  { label: "Setup", commands: entries("setup", "init", "connect", "github-app") },
  { label: "Control Plane", commands: entries("check", "images", "start", "status", "stop", "ui", "docs", "tunnel", "tank", "runtime") },
  { label: "GitHub Relay", commands: entries("relay") },
  { label: "Configuration", commands: entries("config", "remote", "use", "login", "logout") },
  { label: "Plans", commands: entries("plan") },
  { label: "Implementation", commands: entries("issue") },
  { label: "Goals", commands: entries("goal") },
  { label: "Automations", commands: entries("automation"), note: "(Agents: saved automations)" },
  { label: "Tasks", commands: entries("task") },
  { label: "Pull Requests", commands: entries("pr") },
  { label: "Events", commands: entries("events") },
  { label: "Handoffs", commands: entries("handoffs"), note: "(admin recovery for PR follow-up publications)" },
  { label: "Repositories", commands: entries("repo") },
  { label: "Agents", commands: entries("agent"), note: "(coding-agent configurations)" },
  { label: "Settings", commands: entries("setting") },
  { label: "To-Dos", commands: entries("todo") },
  { label: "Logs", commands: entries("log") },
  { label: "Statistics", commands: entries("stats") },
  { label: "Backend", commands: entries("backend", "remote-status", "queue", "admission") },
  { label: "Agent Skills", commands: entries("skill") },
  { label: "Shell", commands: [{ name: "completion", detail: "bash|zsh|fish" }] },
  { label: "Help", commands: [{ name: "help", detail: "command..." }] },
];

const OTHER_GROUP_LABEL = "Other";
const LINE_WIDTH = 100;

/** Visible registered subcommands (excludes Commander's implicit `help`, which is not in `commands`). */
export function visibleSubcommands(command: Command): Command[] {
  return command.createHelp().visibleCommands(command).filter((sub) => command.commands.includes(sub));
}

function describeCommand(command: Command, entry: CommandGroupEntry): string {
  if (entry.detail) return `${entry.name} [${entry.detail}]`;
  const subs = visibleSubcommands(command);
  return subs.length ? `${entry.name} [${subs.map((sub) => sub.name()).join("|")}]` : entry.name;
}

/** Greedy wrap that only breaks after `|` or `, ` so names are never split. */
function wrap(text: string, firstPrefix: string, width: number): string[] {
  const indent = " ".repeat(firstPrefix.length);
  const pieces = text.split(/(?<=\||, )/);
  const lines: string[] = [];
  let line = firstPrefix;
  for (const piece of pieces) {
    if (line.length + piece.trimEnd().length > width && line.trim().length > firstPrefix.trim().length) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += piece;
  }
  lines.push(line.trimEnd());
  return lines;
}

/** Top-level commands that the footer would list under "Other" (should be none). */
export function ungroupedCommands(program: Command): string[] {
  const grouped = new Set(COMMAND_GROUPS.flatMap((group) => group.commands.map((entry) => entry.name)));
  return visibleSubcommands(program).map((command) => command.name()).filter((name) => !grouped.has(name));
}

/** Renders the "Command Groups" section from the registered command tree. */
export function renderCommandGroups(program: Command, width = LINE_WIDTH): string {
  const groups: CommandGroup[] = [...COMMAND_GROUPS];
  const other = ungroupedCommands(program);
  if (other.length) groups.push({ label: OTHER_GROUP_LABEL, commands: entries(...other) });
  const labelWidth = Math.max(...groups.map((group) => group.label.length)) + 2;
  const lines = ["Command Groups:"];
  for (const group of groups) {
    const present = group.commands.flatMap((entry) => {
      const command = program.commands.find((candidate) => candidate.name() === entry.name);
      return command ? [describeCommand(command, entry)] : [];
    });
    if (!present.length) continue;
    const prefix = `  ${`${group.label}:`.padEnd(labelWidth)}`;
    const groupLines = wrap(present.join(", "), prefix, width);
    if (group.note) {
      const last = groupLines.length - 1;
      const withNote = `${groupLines[last]}   ${group.note}`;
      if (withNote.length <= width) groupLines[last] = withNote;
      else groupLines.push(`${" ".repeat(prefix.length)}${group.note}`);
    }
    lines.push(...groupLines);
  }
  return lines.join("\n");
}

/** Resolves `["task", "list"]` to the registered `task list` command. */
export function resolveCommandPath(program: Command, names: readonly string[]): Command | { unknown: string } {
  let command = program;
  for (const [index, name] of names.entries()) {
    const sub = command.commands.find((candidate) => candidate.name() === name || candidate.aliases().includes(name));
    if (!sub) return { unknown: names.slice(0, index + 1).join(" ") };
    command = sub;
  }
  return command;
}

/**
 * Replaces Commander's implicit `help [command]` (which only resolves one
 * level, so `propr help task list` printed the `task` help) with one that
 * resolves the full command path.
 */
export function installNestedHelpCommand(program: Command): void {
  program.helpCommand(false);
  program
    .command("help [command...]")
    .description("display help for command")
    .helpOption(false)
    .action((names: string[] = []) => {
      const target = resolveCommandPath(program, names);
      if ("unknown" in target) {
        program.error(`error: unknown command '${target.unknown}'`, { code: "commander.unknownCommand" });
      }
      (target as Command).help();
    });
}
