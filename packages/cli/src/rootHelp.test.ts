import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Command } from "commander";
import { ALL_MODELS } from "@propr/shared";
import { cliProgram } from "./index.js";
import { COMMAND_GROUPS, renderCommandGroups, resolveCommandPath, ungroupedCommands, visibleSubcommands } from "./rootHelp.js";

function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap((command) => allCommands(command))];
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) names.unshift(current.name());
  return names.join(" ");
}

/** The complete `--help` output of one command, including its addHelpText sections. */
function helpText(command: Command): string {
  let text = "";
  command.configureOutput({ writeOut: (chunk) => { text += chunk; }, writeErr: (chunk) => { text += chunk; } });
  command.outputHelp();
  return text;
}

test("every registered top-level command belongs to a Command Groups entry", () => {
  assert.deepEqual(ungroupedCommands(cliProgram), [], "add the command to COMMAND_GROUPS in src/rootHelp.ts");
  const registered = new Set(cliProgram.commands.map((command) => command.name()));
  for (const group of COMMAND_GROUPS) {
    for (const entry of group.commands) assert.ok(registered.has(entry.name), `${group.label} lists unregistered command "${entry.name}"`);
  }
  const names = COMMAND_GROUPS.flatMap((group) => group.commands.map((entry) => entry.name));
  assert.equal(new Set(names).size, names.length, "a command is listed in two groups");
});

test("the Command Groups footer lists every registered command and subcommand", () => {
  const footer = renderCommandGroups(cliProgram);
  const flat = footer.replace(/\n\s+/g, "");
  assert.doesNotMatch(footer, /^\s+Other:/m);
  for (const command of visibleSubcommands(cliProgram)) {
    const entry = COMMAND_GROUPS.flatMap((group) => group.commands).find((candidate) => candidate.name === command.name());
    const subs = visibleSubcommands(command).map((sub) => sub.name());
    const expected = entry?.detail ? `${command.name()} [${entry.detail}]` : subs.length ? `${command.name()} [${subs.join("|")}]` : command.name();
    assert.ok(flat.includes(expected), `footer is missing "${expected}"`);
  }
  assert.ok(helpText(cliProgram).includes(footer), "root --help does not print the generated footer");
  for (const line of footer.split("\n")) assert.ok(line.length <= 100, `footer line too long: ${line}`);
});

test("a command added later appears in the footer without editing the group table", async () => {
  const { Command: CommanderCommand } = await import("commander");
  const program = new CommanderCommand("propr");
  program.addCommand(new CommanderCommand("task").addCommand(new CommanderCommand("list")).addCommand(new CommanderCommand("brand-new")));
  program.addCommand(new CommanderCommand("mystery"));
  const footer = renderCommandGroups(program);
  assert.match(footer, /Tasks:\s+task \[list\|brand-new\]/);
  assert.match(footer, /Other:\s+mystery/);
  assert.deepEqual(ungroupedCommands(program), ["mystery"]);
});

const MODEL_ID_PATTERN = /\b(?:claude-(?:opus|sonnet|haiku|fable|instant|\d)[\w.-]*|gpt-\d[\w.-]*|o\d-[\w.-]+|(?:antigravity-)?gemini-\d[\w.-]*|mistral-[a-z]+-[\w.-]+|zai-glm-[\w.-]+)/g;

test("help examples only name model ids from the current model definitions", () => {
  const known = new Set(ALL_MODELS.map((model) => model.id));
  const stale: string[] = [];
  for (const command of allCommands(cliProgram)) {
    for (const match of helpText(command).matchAll(MODEL_ID_PATTERN)) {
      const id = match[0].replace(/[.,:;-]+$/, "");
      if (!known.has(id)) stale.push(`${commandPath(command)}: ${id}`);
    }
  }
  assert.deepEqual(stale, []);
});

test("the model id check recognises retired ids", () => {
  const known = new Set(ALL_MODELS.map((model) => model.id));
  for (const retired of ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"]) {
    assert.deepEqual([...`-m ${retired} --wait`.matchAll(MODEL_ID_PATTERN)].map((match) => match[0]), [retired]);
    assert.equal(known.has(retired), false);
  }
});

test("JSON, limit and project flags use the same short forms on every command", () => {
  const mismatched: string[] = [];
  for (const command of allCommands(cliProgram)) {
    for (const option of command.options) {
      const expected = { "--json": "-j", "--limit": "-l", "--project": "-p" }[option.long ?? ""];
      // `config set --project` stores a profile's default project, not a target.
      if (!expected || (option.long === "--project" && commandPath(command).startsWith("propr config"))) continue;
      if (option.short !== expected) mismatched.push(`${commandPath(command)} ${option.flags}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test("stats subcommands accept -p/--project as an alias of --repository", async () => {
  const stats = cliProgram.commands.find((command) => command.name() === "stats");
  assert.ok(stats);
  for (const sub of stats.commands) {
    const flags = sub.options.map((option) => option.flags);
    assert.ok(flags.some((flag) => flag.startsWith("--repository")), `${sub.name()} lost --repository`);
    assert.ok(flags.some((flag) => flag.startsWith("-p, --project")), `${sub.name()} lacks -p, --project`);
  }
});

test("help resolves a full command path", () => {
  const list = resolveCommandPath(cliProgram, ["task", "list"]);
  assert.ok(!("unknown" in list));
  assert.equal(commandPath(list as Command), "propr task list");
  assert.deepEqual(resolveCommandPath(cliProgram, ["task", "nope"]), { unknown: "task nope" });

  const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint, "help", "task", "list"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: propr task list \[options\]/);

  const unknown = spawnSync(process.execPath, ["--import", "tsx", entryPoint, "help", "task", "nope"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command 'task nope'/);
});

test("plan create -b shows its default once", () => {
  const plan = resolveCommandPath(cliProgram, ["plan", "create"]) as Command;
  const branch = plan.options.find((option) => option.long === "--branch");
  assert.ok(branch);
  assert.doesNotMatch(helpText(plan), /\(default: main\) \(default: "main"\)/);
});
