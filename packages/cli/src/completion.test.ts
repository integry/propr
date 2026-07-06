import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import {
  buildCompletionMetadata,
  completionScript,
  escapeForDoubleQuotes,
  escapeForFishSingleQuotes,
} from "./completion.js";
import { createTaskCommand } from "./commands/taskCommands.js";
import { createSettingCommand } from "./commands/settingCommands.js";
import { createConfigCommand } from "./commands/configCommands.js";
import { createBackendCommand } from "./commands/systemCommands.js";

/**
 * Builds a command tree with the command groups the completion assertions
 * exercise, using the real factories so the scripts reflect actual metadata.
 */
function buildTestProgram(): Command {
  const program = new Command("propr");
  program.addCommand(createTaskCommand());
  program.addCommand(createSettingCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createBackendCommand());
  return program;
}

test("completion scripts include new command groups and options", () => {
  const bash = completionScript(buildTestProgram(), "bash");

  assert.match(bash, /task followup/);
  assert.match(bash, /task import/);
  assert.match(bash, /task revert/);
  assert.match(bash, /setting reindex-summaries/);
  assert.match(bash, /config profile set/);
  assert.match(bash, /backend/);
  assert.match(bash, /--dry-run/);
  assert.match(bash, /--clear-token/);
  assert.match(bash, /--ignore-cooldown/);
});

test("completion command supports every advertised shell", () => {
  const program = buildTestProgram();
  assert.match(completionScript(program, "bash"), /complete -F _propr_completion propr/);
  assert.match(completionScript(program, "zsh"), /#compdef propr/);
  assert.match(completionScript(program, "fish"), /complete -c propr/);
});

test("bash completion completes files only after file-taking options", () => {
  const bash = completionScript(buildTestProgram(), "bash");
  const metadata = buildCompletionMetadata(buildTestProgram());

  assert.deepEqual(metadata.fileOptions.sort(), ["--file", "-f"].sort());
  assert.equal(metadata.valueOptions.includes("--project"), true);
  assert.equal(metadata.valueOptions.includes("--file"), false);

  // Exactly one file-completion arm, guarded by the file options; other value
  // options suppress suggestions instead of offering filenames.
  assert.equal((bash.match(/compgen -f/g) ?? []).length, 1);
  assert.match(bash, /"--file"\|"-f"\) COMPREPLY=\( \$\(compgen -f -- "\$cur"\) \); return 0 ;;/);
  assert.match(bash, /"--project"[^\n]*\) return 0 ;;/);
});

test("options complete for single-word commands", () => {
  const program = new Command("propr");
  program.command("queue").description("queue").option("-j, --json", "JSON output");

  const bash = completionScript(program, "bash");
  assert.match(bash, /case "\$path1" in/);
  assert.match(bash, /"queue"\) COMPREPLY=\( \$\(compgen -W "--json -j" -- "\$cur"\) \); return 0 ;;/);

  const zsh = completionScript(program, "zsh");
  assert.match(zsh, /case "\$path1" in/);
  assert.match(zsh, /"queue"\) compadd -- "--json" "-j"; return ;;/);
});

test("group subcommand suggestions are gated on cursor depth", () => {
  const bash = completionScript(buildTestProgram(), "bash");
  assert.match(bash, /if \[\[ \$\{COMP_CWORD\} -eq 2 \]\]; then/);

  const zsh = completionScript(buildTestProgram(), "zsh");
  assert.match(zsh, /if \(\( CURRENT == 3 \)\); then/);
});

test("fish registers options as options rather than arguments", () => {
  const fish = completionScript(buildTestProgram(), "fish");
  assert.match(fish, /-l 'json'/);
  assert.match(fish, /-s 'j'/);
  assert.doesNotMatch(fish, /-a '--/);
});

test("zsh completion derives nested subcommands from metadata and avoids _values", () => {
  const zsh = completionScript(buildTestProgram(), "zsh");
  assert.match(zsh, /"config profile"\) compadd -- "use" "set"; return ;;/);
  assert.doesNotMatch(zsh, /_values/);
});

test("nested subcommand metadata covers every two-level command group", () => {
  const metadata = buildCompletionMetadata(buildTestProgram());
  assert.deepEqual(metadata.nestedSubcommands.config?.profile, ["use", "set"]);
  assert.deepEqual(metadata.subcommands.backend, ["status", "queue"]);
});

test("shell metadata words are escaped when embedded in scripts", () => {
  assert.equal(escapeForDoubleQuotes('na"me$1`x\\'), 'na\\"me\\$1\\`x\\\\');
  assert.equal(escapeForFishSingleQuotes("it's\\here"), "it\\'s\\\\here");

  const program = new Command("propr");
  program
    .command('weird"cmd')
    .description("command with a quote in its name")
    .command("sub")
    .description("nested");
  const bash = completionScript(program, "bash");
  assert.match(bash, /weird\\"cmd/);
  assert.doesNotMatch(bash, /[^\\]weird"cmd/);
});
