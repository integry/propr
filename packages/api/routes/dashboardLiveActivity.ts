/**
 * What a running agent is doing right now, in one line.
 *
 * A running row that shows only a title and a ticking timer cannot answer the
 * question someone glancing at it is asking: is this run doing work, or is it
 * hung? The live-details projection already holds the answer — the agent's
 * plan, its latest tool call and when it last produced anything — so this
 * reduces it to the facts a row can carry: the current sub-phase, how far
 * through its own plan the agent is, and when it last produced output.
 *
 * Nothing here is synthesised. A step count comes from the agent's own todo
 * list, an action from a tool call it actually made, and a timestamp from an
 * event it actually emitted; anything the stream does not show is null.
 */

/** The slice of a live-details projection this reads. */
export interface LiveDetailsSnapshot {
  currentTask?: string | null;
  todos?: ReadonlyArray<{ status?: unknown; content?: unknown }> | null;
  events?: ReadonlyArray<Record<string, unknown>> | null;
}

export interface LiveActivity {
  /** The plan step the agent marked in progress. */
  progressLine: string | null;
  /** The agent's latest action, described from its most recent tool call. */
  activity: string | null;
  /** Position in the agent's own plan, when it keeps one. */
  step: { current: number; total: number } | null;
  /** When the agent last produced any output. */
  lastActivityAt: string | null;
  /**
   * True only when the stream was read and the agent has produced nothing in
   * it yet. A stream that could not be read, or was not read at all, is
   * unknown rather than empty, and says false.
   */
  awaitingFirstOutput: boolean;
}

/** Nothing known about the stream: it was not read, or could not be. */
export const EMPTY_LIVE_ACTIVITY: LiveActivity = {
  progressLine: null,
  activity: null,
  step: null,
  lastActivityAt: null,
  awaitingFirstOutput: false,
};

const MAX_ACTIVITY_LENGTH = 120;
/** Bookkeeping calls: they say nothing about what the agent is working on. */
const BOOKKEEPING_TOOLS = new Set(['todowrite', 'todoread', 'update_plan', 'exitplanmode']);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null;

const clip = (value: string): string =>
  value.length <= MAX_ACTIVITY_LENGTH ? value : `${value.slice(0, MAX_ACTIVITY_LENGTH - 1).trimEnd()}…`;

/**
 * The file a tool touched, by name.
 *
 * Tool inputs carry absolute paths inside the agent's workspace, and the
 * directories are the host's, not the repository's. The file name is the part
 * a person recognises, and it does not publish where the worktree lives.
 */
const fileName = (value: unknown): string | null => {
  const path = text(value);
  if (!path) return null;
  const segments = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return segments[segments.length - 1] || null;
};

const inputPath = (input: Record<string, unknown>): string | null =>
  fileName(input.file_path ?? input.filePath ?? input.path ?? input.notebook_path);

/**
 * A shell command as a person would name it.
 *
 * Claude's Bash tool asks the model for a short description of every command;
 * when there is one it is the better line. Otherwise the command itself, minus
 * the `cd <workspace> &&` preamble that begins most of them.
 */
function describeCommand(input: Record<string, unknown>): string | null {
  const description = text(input.description);
  if (description) return description;
  const raw = Array.isArray(input.command) ? input.command.filter(part => typeof part === 'string').join(' ') : input.command;
  const command = text(raw)?.replace(/^(?:bash|sh|zsh) -l?c\s+/, '').replace(/^['"]|['"]$/g, '');
  if (!command) return null;
  const withoutPreamble = command.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '');
  return `Running ${withoutPreamble || command}`;
}

function describeFileChange(input: Record<string, unknown>): string {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const names = changes
    .map(change => (change && typeof change === 'object' ? fileName((change as Record<string, unknown>).path) : null))
    .filter((name): name is string => name !== null);
  if (names.length === 0) return 'Editing files';
  return names.length === 1 ? `Editing ${names[0]}` : `Editing ${names[0]} and ${names.length - 1} more`;
}

type Describe = (input: Record<string, unknown>) => string;

const withPath = (verb: string, fallback: string): Describe =>
  input => {
    const path = inputPath(input);
    return path ? `${verb} ${path}` : fallback;
  };

const describeSearch: Describe = input => {
  const pattern = text(input.pattern ?? input.query);
  return pattern ? `Searching for ${pattern}` : 'Searching the code';
};

const describeFetch: Describe = input => {
  try {
    return `Fetching ${new URL(String(input.url)).host}`;
  } catch {
    return 'Fetching a web page';
  }
};

const describeSubagent: Describe = input => {
  const description = text(input.description);
  return description ? `Sub-agent: ${description}` : 'Running a sub-agent';
};

/** Tool names across the providers' parsers, by the action each performs. */
const DESCRIBERS: ReadonlyArray<[readonly string[], Describe]> = [
  [['bash', 'shell', 'command_execution', 'exec_command'], input => describeCommand(input) ?? 'Running a command'],
  [['read', 'view', 'read_file'], withPath('Reading', 'Reading files')],
  [['edit', 'multiedit', 'notebookedit', 'str_replace'], withPath('Editing', 'Editing files')],
  [['write', 'write_file', 'create'], withPath('Writing', 'Writing files')],
  [['filechange', 'apply_patch', 'patch'], describeFileChange],
  [['grep', 'glob', 'search', 'list', 'ls'], describeSearch],
  [['websearch', 'web_search'], () => 'Searching the web'],
  [['webfetch', 'fetch'], describeFetch],
  [['task', 'agent'], describeSubagent],
];

const DESCRIBER_BY_TOOL = new Map<string, Describe>(
  DESCRIBERS.flatMap(([names, describe]) => names.map(name => [name, describe] as const)),
);

/** One tool call, described as the action it performs. Null for bookkeeping. */
export function describeToolUse(toolName: string, input: Record<string, unknown> = {}): string | null {
  const name = toolName.toLowerCase();
  if (BOOKKEEPING_TOOLS.has(name)) return null;
  const describe = DESCRIBER_BY_TOOL.get(name);
  return describe ? describe(input) : `Using ${toolName}`;
}

/** The latest action: the most recent tool call that is not plan bookkeeping. */
function latestAction(events: ReadonlyArray<Record<string, unknown>>): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'tool_use' || typeof event.toolName !== 'string') continue;
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
    const action = describeToolUse(event.toolName, input);
    if (action) return clip(action);
  }
  return null;
}

function latestTimestamp(events: ReadonlyArray<Record<string, unknown>>): string | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    // A raw-output fallback carries no real event time.
    if (event.rawFallback === true || typeof event.timestamp !== 'string') continue;
    const time = Date.parse(event.timestamp);
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

/**
 * Where the agent is in its own plan: the step in progress, of how many.
 *
 * Counted only while a step is actually in progress, so a finished or unstarted
 * plan is not reported as a position.
 */
function planStep(todos: LiveDetailsSnapshot['todos']): LiveActivity['step'] {
  if (!todos || todos.length === 0) return null;
  if (!todos.some(todo => todo.status === 'in_progress')) return null;
  const completed = todos.filter(todo => todo.status === 'completed').length;
  return { current: Math.min(completed + 1, todos.length), total: todos.length };
}

/** A stream that was read and holds no output yet. */
export const EMPTY_LIVE_DETAILS: LiveDetailsSnapshot = Object.freeze({ currentTask: null, todos: [], events: [] });

/**
 * A stream that was read, reduced to what a row can carry.
 *
 * Only a snapshot says anything about the stream. `null` is a projection that
 * produced nothing — which the shared projector also returns when its read
 * failed — so it is unknown, not empty: saying the agent has not written
 * anything yet would be a claim no read established. A caller that read the
 * stream and found nothing passes `EMPTY_LIVE_DETAILS`.
 */
export function summariseLiveActivity(live: LiveDetailsSnapshot | null | undefined): LiveActivity {
  if (!live) return EMPTY_LIVE_ACTIVITY;
  const events = live.events ?? [];
  const progressLine = typeof live.currentTask === 'string' && live.currentTask.trim() ? live.currentTask : null;
  const todos = live.todos ?? [];
  return {
    progressLine,
    activity: latestAction(events),
    step: planStep(todos),
    lastActivityAt: latestTimestamp(events),
    awaitingFirstOutput: events.length === 0 && todos.length === 0 && progressLine === null,
  };
}
