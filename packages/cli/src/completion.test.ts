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

test("bash completion falls back to file completion after value options", () => {
  const bash = completionScript(buildTestProgram(), "bash");
  assert.match(bash, /compgen -f -- "\$cur"/);
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
