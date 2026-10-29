// One bounded line naming why an agent run failed, never its raw container output.
export const AGENT_FAILURE_LINE_MAX_CHARS = 500;

// eslint-disable-next-line no-control-regex -- ANSI escapes are control sequences
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Notices the agent entrypoints print before the CLI starts, the `ls` listing
// of a mounted config directory, and shell traces of the launch command.
const ENTRYPOINT_NOTICE = new RegExp([
    '^GitHub token detected', '^GitHub CLI will use', '^Warning: GH_TOKEN', '^GitHub operations may fail',
    '^Using disposable ', ' config directory mounted', '^Contents of ', '^Creating missing directory',
    '^Fixing (?:ownership|permissions)', '^Setting up GitHub CLI wrapper', '^Running as correct user',
    '^Workspace ownership is correct', '^Executing command:', '^Switching to node user', '^Git safe directory',
    ' configuration found$', '^Configured confined', 'authentication-related configuration found',
    '^total \\d+$', '^[dl-][rwxsStT-]{9}[.@+]?\\s', '^\\++ ', '^exec ',
].join('|'));
// `error: …` from a CLI, `Error: …`/`TypeError: …` from Node, `fatal: …` from git.
const ERROR_LINE = /^(?:[A-Za-z]*Error\b|error\b|ERROR\b|fatal\b|FATAL\b|panic\b)/;
// Node's `file:line[:column]` source location printed above an uncaught error.
const STACK_LOCATION = /^\S+:\d+(?::\d+)?$/;

/**
 * Picks the line of an agent's output that names its failure. After an
 * entrypoint preamble or a source location that is the first error line, else
 * the first other line; any other message keeps its own first line. Callers redact.
 */
export function agentFailureLine(output: string): string {
    const lines = output.replace(ANSI_ESCAPE, '').split('\n').map(line => line.trim()).filter(Boolean);
    const candidates = lines.filter(line => !ENTRYPOINT_NOTICE.test(line));
    const searchErrorLine = candidates.length < lines.length || STACK_LOCATION.test(candidates[0] ?? '');
    const errorLine = searchErrorLine ? candidates.find(candidate => ERROR_LINE.test(candidate)) : undefined;
    const line = errorLine ?? candidates[0] ?? lines.at(-1) ?? '';
    return line.length > AGENT_FAILURE_LINE_MAX_CHARS ? `${line.slice(0, AGENT_FAILURE_LINE_MAX_CHARS)}…` : line;
}
