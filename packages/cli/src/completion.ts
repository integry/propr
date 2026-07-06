/**
 * Shell Completion Generation
 *
 * Builds bash/zsh/fish completion scripts from a commander command tree.
 * Lives in its own module (rather than the CLI entry point) so it can be
 * unit-tested in-process without executing the CLI.
 */

import { Command } from "commander";

export type CompletionShell = "bash" | "zsh" | "fish";

export interface CompletionMetadata {
  commands: string[];
  subcommands: Record<string, string[]>;
  nestedSubcommands: Record<string, Record<string, string[]>>;
  options: Record<string, string[]>;
  /** Value-taking option flags whose argument is not a file path. */
  valueOptions: string[];
  /** Value-taking option flags whose argument is a file path. */
  fileOptions: string[];
}

/**
 * Escapes a word for embedding inside a double-quoted bash/zsh string.
 */
export function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

/**
 * Escapes a word for embedding inside a single-quoted fish string.
 */
export function escapeForFishSingleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function quoteWords(words: string[]): string {
  return words.map((word) => `"${escapeForDoubleQuotes(word)}"`).join(" ");
}

function joinEscaped(words: string[]): string {
  return words.map((word) => escapeForDoubleQuotes(word)).join(" ");
}

function casePattern(words: string[]): string {
  return words.map((word) => `"${escapeForDoubleQuotes(word)}"`).join("|");
}

function commandPath(command: Command, path: string[]): string {
  return [...path, command.name()].join(" ");
}

function commandOptionFlags(command: Command): string[] {
  return command.options.flatMap((option) => [option.long, option.short].filter((flag): flag is string => Boolean(flag)));
}

function collectValueOptionFlags(command: Command, valueOptions: Set<string>, fileOptions: Set<string>): void {
  for (const option of command.options) {
    if (!option.required && !option.optional) continue;
    const target = option.long === "--file" ? fileOptions : valueOptions;
    for (const flag of [option.long, option.short]) {
      if (flag) target.add(flag);
    }
  }
}

export function buildCompletionMetadata(root: Command): CompletionMetadata {
  const commands = root.commands.map((command) => command.name());
  const subcommands: Record<string, string[]> = {};
  const nestedSubcommands: Record<string, Record<string, string[]>> = {};
  const options: Record<string, string[]> = {};
  const valueOptions = new Set<string>();
  const fileOptions = new Set<string>();
  collectValueOptionFlags(root, valueOptions, fileOptions);

  function visit(command: Command, parentPath: string[]): void {
    const path = commandPath(command, parentPath);
    const flags = commandOptionFlags(command);
    if (flags.length > 0) options[path] = flags;
    collectValueOptionFlags(command, valueOptions, fileOptions);
    if (command.commands.length > 0) {
      if (parentPath.length === 0) {
        subcommands[command.name()] = command.commands.map((subcommand) => subcommand.name());
      } else if (parentPath.length === 1) {
        nestedSubcommands[parentPath[0]] ??= {};
        nestedSubcommands[parentPath[0]][command.name()] = command.commands.map((subcommand) => subcommand.name());
      }
    }
    for (const subcommand of command.commands) visit(subcommand, [...parentPath, command.name()]);
  }

  for (const command of root.commands) visit(command, []);
  return {
    commands,
    subcommands,
    nestedSubcommands,
    options,
    valueOptions: Array.from(valueOptions).filter((flag) => !fileOptions.has(flag)),
    fileOptions: Array.from(fileOptions),
  };
}

/**
 * Formats a flag as fish `complete` option arguments (`-l name` / `-s n`) so
 * options are registered as options rather than positional arguments.
 */
function fishOptionArgs(flag: string): string {
  if (flag.startsWith("--")) return `-l '${escapeForFishSingleQuotes(flag.slice(2))}'`;
  return `-s '${escapeForFishSingleQuotes(flag.slice(1))}'`;
}

export function completionScript(root: Command, shell: CompletionShell): string {
  const { commands, subcommands, nestedSubcommands, options, valueOptions, fileOptions } = buildCompletionMetadata(root);
  const commandWords = joinEscaped(commands);
  const optionCases = Object.entries(options)
    .map(([path, opts]) => `    "${escapeForDoubleQuotes(path)}") COMPREPLY=( $(compgen -W "${joinEscaped(opts)}" -- "$cur") ); return 0 ;;`)
    .join("\n");
  const zshOptionCases = Object.entries(options)
    .map(([path, opts]) => `    "${escapeForDoubleQuotes(path)}") compadd -- ${quoteWords(opts)}; return ;;`)
    .join("\n");
  const zshNestedCases = Object.entries(nestedSubcommands)
    .flatMap(([cmd, nested]) => Object.entries(nested).map(([sub, subs]) => `      "${escapeForDoubleQuotes(`${cmd} ${sub}`)}") compadd -- ${quoteWords(subs)}; return ;;`))
    .join("\n");
  // Files only complete after file-taking options; other value options take
  // free-form arguments, so suggesting filenames there is noise.
  const bashValueArms = [
    ...(fileOptions.length > 0 ? [`    ${casePattern(fileOptions)}) COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;`] : []),
    ...(valueOptions.length > 0 ? [`    ${casePattern(valueOptions)}) return 0 ;;`] : []),
  ].join("\n");
  const zshValueArms = [
    ...(fileOptions.length > 0 ? [`    ${casePattern(fileOptions)}) _files; return ;;`] : []),
    ...(valueOptions.length > 0 ? [`    ${casePattern(valueOptions)}) return ;;`] : []),
  ].join("\n");

  if (shell === "zsh") {
    return `#compdef propr
_propr() {
  if (( CURRENT == 2 )); then
    compadd -- ${quoteWords(commands)}
    return
  fi
  case "$words[CURRENT-1]" in
${zshValueArms}
  esac
  if [[ "$words[CURRENT]" == -* ]]; then
    local path3="$words[2] $words[3] $words[4]"
    local path2="$words[2] $words[3]"
    local path1="$words[2]"
    case "$path3" in
${zshOptionCases}
    esac
    case "$path2" in
${zshOptionCases}
    esac
    case "$path1" in
${zshOptionCases}
    esac
  fi
  if (( CURRENT == 4 )); then
    case "$words[2] $words[3]" in
${zshNestedCases}
    esac
  fi
  if (( CURRENT == 3 )); then
    case "$words[2]" in
${Object.entries(subcommands).map(([cmd, subs]) => `    "${escapeForDoubleQuotes(cmd)}") compadd -- ${quoteWords(subs)} ;;`).join("\n")}
    esac
  fi
}
_propr
`;
  }

  if (shell === "fish") {
    const lines = commands.map((cmd) => `complete -c propr -f -n '__fish_use_subcommand' -a '${escapeForFishSingleQuotes(cmd)}'`);
    for (const [cmd, subs] of Object.entries(subcommands)) {
      lines.push(`complete -c propr -f -n '__fish_seen_subcommand_from ${escapeForFishSingleQuotes(cmd)}' -a '${escapeForFishSingleQuotes(subs.join(" "))}'`);
    }
    for (const [cmd, nested] of Object.entries(nestedSubcommands)) {
      for (const [sub, subs] of Object.entries(nested)) {
        lines.push(`complete -c propr -f -n '__fish_seen_subcommand_from ${escapeForFishSingleQuotes(cmd)}; and __fish_seen_subcommand_from ${escapeForFishSingleQuotes(sub)}' -a '${escapeForFishSingleQuotes(subs.join(" "))}'`);
      }
    }
    for (const [path, opts] of Object.entries(options)) {
      const parts = path.split(" ");
      const condition = parts.map((part) => `__fish_seen_subcommand_from ${escapeForFishSingleQuotes(part)}`).join("; and ");
      for (const option of opts) {
        lines.push(`complete -c propr -f -n '${condition}' ${fishOptionArgs(option)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  return `_propr_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
${bashValueArms}
  esac
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commandWords}" -- "$cur") )
    return 0
  fi
  if [[ "$cur" == -* ]]; then
    local path3="\${COMP_WORDS[1]} \${COMP_WORDS[2]} \${COMP_WORDS[3]}"
    local path2="\${COMP_WORDS[1]} \${COMP_WORDS[2]}"
    local path1="\${COMP_WORDS[1]}"
    case "$path3" in
${optionCases}
    esac
    case "$path2" in
${optionCases}
    esac
    case "$path1" in
${optionCases}
    esac
  fi
  if [[ \${COMP_CWORD} -eq 3 ]]; then
    case "\${COMP_WORDS[1]} \${COMP_WORDS[2]}" in
${Object.entries(nestedSubcommands).flatMap(([cmd, nested]) => Object.entries(nested).map(([sub, subs]) => `      "${escapeForDoubleQuotes(`${cmd} ${sub}`)}") COMPREPLY=( $(compgen -W "${joinEscaped(subs)}" -- "$cur") ); return 0 ;;`)).join("\n")}
    esac
  fi
  if [[ \${COMP_CWORD} -eq 2 ]]; then
    case "\${COMP_WORDS[1]}" in
${Object.entries(subcommands).map(([cmd, subs]) => `    "${escapeForDoubleQuotes(cmd)}") COMPREPLY=( $(compgen -W "${joinEscaped(subs)}" -- "$cur") ) ;;`).join("\n")}
    esac
  fi
}
complete -F _propr_completion propr
`;
}
