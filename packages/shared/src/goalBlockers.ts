/**
 * Durable, evidence-backed goal blockers.
 *
 * One projection decides what a goal needs from its operator, and every surface
 * reads it: the goal console, `get_goal`, the attention listing, activity
 * digests, the dashboard and the CLI. A blocker exists only for an explicit
 * signal — a confirmed pause, or a structured provider request for a question
 * or an approval. Silence, slow work, narrative text, rate limits and queued
 * corrections never produce one.
 */

/** What the operator is being asked for. */
export const GOAL_BLOCKER_CATEGORIES = ['question', 'approval', 'paused'] as const;
export type GoalBlockerCategory = typeof GOAL_BLOCKER_CATEGORIES[number];

/** Provider-raised categories, persisted in `goal_blockers`. `paused` is derived from the goal row. */
export type GoalProviderBlockerCategory = Exclude<GoalBlockerCategory, 'paused'>;

/**
 * The supported control that resolves a blocker. Each maps to an existing goal
 * endpoint and MCP tool; there is no generic keystroke injection and no
 * automatic approval.
 */
export const GOAL_BLOCKER_ACTIONS = ['send_input', 'resume', 'pause', 'cancel'] as const;
export type GoalBlockerAction = typeof GOAL_BLOCKER_ACTIONS[number];

/** How a category is detected for a provider. */
export type GoalBlockerSupport =
  /** Detected from a structured event and answerable through a supported control. */
  | 'supported'
  /** Detected from a structured event; the response is a pause or cancel handoff, never an approval. */
  | 'handoff'
  /** The provider exposes no structured signal ProPR can trust; nothing is reported. */
  | 'unavailable';

export interface GoalBlockerProviderSupport {
  question: GoalBlockerSupport;
  approval: GoalBlockerSupport;
  paused: GoalBlockerSupport;
  /** Where the signal comes from, or why it is unavailable. */
  notes: string;
}

/**
 * Audited per provider integration. A provider absent from this table is
 * treated like `unavailable` for question and approval.
 */
export const GOAL_BLOCKER_PROVIDER_SUPPORT: Readonly<Record<string, GoalBlockerProviderSupport>> = {
  codex: {
    question: 'supported',
    approval: 'handoff',
    paused: 'supported',
    notes: 'Codex App Server `item/tool/requestUserInput` server requests asking one question are answered with the next goal input while no other answerable question waits; '
      + 'multi-question and secret requests are handed off; '
      + 'command, file-change and permission approval requests are reported but never approved by ProPR. '
      + '`serverRequest/resolved` or the end of the turn resolves them.',
  },
  claude: {
    question: 'unavailable',
    approval: 'unavailable',
    paused: 'supported',
    notes: 'Claude goal sessions run headless with permissions bypassed and no permission-prompt tool, '
      + 'so the stream carries no structured question or approval request.',
  },
  antigravity: {
    question: 'unavailable',
    approval: 'unavailable',
    paused: 'supported',
    notes: 'Antigravity print mode runs with permissions bypassed; approvals exist only in its interactive TUI.',
  },
};

const UNAVAILABLE_SUPPORT: GoalBlockerProviderSupport = {
  question: 'unavailable',
  approval: 'unavailable',
  paused: 'supported',
  notes: 'This provider exposes no structured question or approval signal to ProPR.',
};

export function goalBlockerSupport(provider: string | null | undefined): GoalBlockerProviderSupport {
  return (provider && GOAL_BLOCKER_PROVIDER_SUPPORT[provider]) || UNAVAILABLE_SUPPORT;
}

/** One provider question, displayed as untrusted data. */
export interface GoalBlockerQuestion {
  id: string;
  header: string | null;
  question: string;
  options: string[];
  /**
   * The provider marked the answer secret, so ProPR does not relay it through persisted goal input.
   * Not named `secret`: credential-shaped keys are stripped from MCP payloads.
   */
  confidential: boolean;
}

export interface GoalBlocker {
  /** Stable across reads, reconnects and repeated provider events. */
  id: string;
  goalId: string;
  repository: string;
  taskId: string | null;
  /** The execution attempt and provider session that observed the blocker. */
  attempt: {
    generation: number | null;
    claim: string | null;
    sessionId: string | null;
    turnId: string | null;
  };
  category: GoalBlockerCategory;
  provider: string | null;
  /** Bounded, secret-redacted provider text or ProPR's own description. Untrusted data. */
  summary: string;
  questions: GoalBlockerQuestion[];
  detection: {
    kind: 'goal_control' | 'provider_event';
    source: string;
  };
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  /** Projected blockers are always open; resolved and superseded rows are never projected. */
  status: 'open';
  /** Whether at least one supported response action is available. */
  actionable: boolean;
  responseActions: GoalBlockerAction[];
  /** What the response actions do, in one sentence. */
  responseHint: string;
}

export type GoalAttentionReason =
  | 'paused_awaiting_resume_or_input'
  | 'provider_question'
  | 'provider_approval';

export interface GoalAttention {
  waitingForOperator: boolean;
  /** The reason of the oldest open blocker; preserved as `paused_awaiting_resume_or_input` for a pause. */
  reason: GoalAttentionReason | null;
  blockers: GoalBlocker[];
}

/** The `goals` columns the projection reads. */
export interface GoalBlockerGoalState {
  goal_id: string;
  repository: string;
  current_task_id?: string | null;
  agent_type?: string | null;
  desired_state: string | null;
  result_state: string | null;
  pause_confirmed_at: unknown;
  resume_requested: number | boolean | null;
  run_generation?: number | null;
  run_claim?: string | null;
  session_id?: string | null;
}

/** A persisted `goal_blockers` row. */
export interface GoalBlockerRow {
  blocker_id: string;
  goal_id: string;
  repository: string;
  task_id: string | null;
  run_generation: number | null;
  run_claim: string | null;
  session_id: string | null;
  turn_id: string | null;
  provider: string | null;
  category: string;
  source: string;
  summary: string | null;
  questions: string | unknown[] | null;
  response_actions: string | unknown[] | null;
  status: string;
  first_observed_at: unknown;
  last_observed_at: unknown;
}

export const GOAL_BLOCKER_SUMMARY_LIMIT = 1000;
export const GOAL_BLOCKER_QUESTION_LIMIT = 1000;
export const GOAL_BLOCKER_HEADER_LIMIT = 200;
export const GOAL_BLOCKER_OPTION_LIMIT = 200;
export const GOAL_BLOCKER_MAX_QUESTIONS = 10;
export const GOAL_BLOCKER_MAX_OPTIONS = 10;

/** Collapse whitespace and bound provider text by characters. */
export function boundGoalBlockerText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  return characters.length <= limit ? normalized : `${characters.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

function isoTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;
  if (typeof value !== 'string') return null;
  // Database timestamps without an offset are stored in UTC.
  const sqlite = SQLITE_TIMESTAMP.exec(value);
  const parsed = new Date(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Questions are re-bounded on read, so a row written by an older worker cannot widen the projection. */
export function normalizeGoalBlockerQuestions(value: unknown): GoalBlockerQuestion[] {
  return parseJsonArray(value).slice(0, GOAL_BLOCKER_MAX_QUESTIONS).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const question = boundGoalBlockerText(record.question, GOAL_BLOCKER_QUESTION_LIMIT);
    if (!question) return [];
    const header = boundGoalBlockerText(record.header, GOAL_BLOCKER_HEADER_LIMIT);
    const options = Array.isArray(record.options)
      ? record.options.slice(0, GOAL_BLOCKER_MAX_OPTIONS)
        .map(option => boundGoalBlockerText(option, GOAL_BLOCKER_OPTION_LIMIT)).filter(Boolean)
      : [];
    return [{
      id: boundGoalBlockerText(record.id, GOAL_BLOCKER_HEADER_LIMIT) || question,
      header: header || null,
      question,
      options,
      confidential: record.confidential === true,
    }];
  });
}

function normalizeActions(value: unknown): GoalBlockerAction[] {
  const allowed = new Set<string>(GOAL_BLOCKER_ACTIONS);
  return [...new Set(parseJsonArray(value).filter((action): action is GoalBlockerAction =>
    typeof action === 'string' && allowed.has(action)))];
}

const RESPONSE_HINTS: Record<GoalBlockerCategory, (actions: GoalBlockerAction[]) => string> = {
  paused: () => 'The goal is paused. Resume it, or send input to resume with a correction.',
  question: actions => actions.includes('send_input')
    ? 'Send goal input to answer; ProPR delivers it as the reply to this question. Sending alone does not resolve it — the provider does.'
    : 'This question cannot be answered through ProPR. Pause or cancel the goal to hand it off.',
  approval: () => 'ProPR never approves provider requests. Pause or cancel the goal; the request is withdrawn at the provider turn boundary.',
};

const SEVERAL_QUESTIONS_HINT = 'Several questions are waiting, and a goal input cannot name the one it answers. '
  + 'Answer once only one remains, or pause or cancel the goal to hand them off.';

/** A confirmed pause with no queued resume. A queued resume is no longer waiting for a pause response. */
export function isGoalPausedAwaitingOperator(goal: Pick<GoalBlockerGoalState,
  'result_state' | 'desired_state' | 'pause_confirmed_at' | 'resume_requested'>): boolean {
  return !goal.result_state && goal.desired_state === 'paused' && Boolean(goal.pause_confirmed_at) && !goal.resume_requested;
}

function pausedBlocker(goal: GoalBlockerGoalState): GoalBlocker {
  const pausedAt = isoTimestamp(goal.pause_confirmed_at);
  const actions: GoalBlockerAction[] = ['resume', 'send_input', 'cancel'];
  return {
    id: `goal-pause:${goal.goal_id}:${pausedAt ?? 'confirmed'}`,
    goalId: goal.goal_id,
    repository: goal.repository,
    taskId: goal.current_task_id ?? null,
    attempt: {
      generation: goal.run_generation ?? null,
      claim: goal.run_claim ?? null,
      sessionId: goal.session_id ?? null,
      turnId: null,
    },
    category: 'paused',
    provider: goal.agent_type ?? null,
    summary: 'Goal is paused and waiting for you to resume it or send input.',
    questions: [],
    detection: { kind: 'goal_control', source: 'pause_confirmed' },
    firstObservedAt: pausedAt,
    lastObservedAt: pausedAt,
    status: 'open',
    actionable: true,
    responseActions: actions,
    responseHint: RESPONSE_HINTS.paused(actions),
  };
}

/**
 * Whether a persisted provider blocker still belongs to the goal's live
 * attempt. A row from an older generation, another claim or a replaced session
 * is stale evidence and is never projected, even if a write to close it was
 * lost.
 */
export function isCurrentGoalBlocker(goal: GoalBlockerGoalState, row: GoalBlockerRow): boolean {
  if (row.status !== 'open' || row.goal_id !== goal.goal_id) return false;
  if (goal.result_state || goal.desired_state !== 'running') return false;
  if (goal.run_generation == null || Number(row.run_generation) !== Number(goal.run_generation)) return false;
  if (!goal.run_claim || row.run_claim !== goal.run_claim) return false;
  if (row.session_id && goal.session_id && row.session_id !== goal.session_id) return false;
  return row.category === 'question' || row.category === 'approval';
}

function providerBlocker(goal: GoalBlockerGoalState, row: GoalBlockerRow): GoalBlocker {
  const category = row.category as GoalProviderBlockerCategory;
  const questions = normalizeGoalBlockerQuestions(row.questions);
  const actions = normalizeActions(row.response_actions);
  return {
    id: row.blocker_id,
    goalId: goal.goal_id,
    repository: goal.repository,
    taskId: row.task_id ?? goal.current_task_id ?? null,
    attempt: {
      generation: row.run_generation == null ? null : Number(row.run_generation),
      claim: row.run_claim ?? null,
      sessionId: row.session_id ?? null,
      turnId: row.turn_id ?? null,
    },
    category,
    provider: row.provider ?? goal.agent_type ?? null,
    summary: boundGoalBlockerText(row.summary, GOAL_BLOCKER_SUMMARY_LIMIT)
      || (category === 'approval' ? 'The provider is waiting for an approval.' : 'The provider asked a question.'),
    questions,
    detection: { kind: 'provider_event', source: boundGoalBlockerText(row.source, 100) },
    firstObservedAt: isoTimestamp(row.first_observed_at),
    lastObservedAt: isoTimestamp(row.last_observed_at),
    status: 'open',
    actionable: actions.length > 0,
    responseActions: actions,
    responseHint: RESPONSE_HINTS[category](actions),
  };
}

const ATTENTION_REASON: Record<GoalBlockerCategory, GoalAttentionReason> = {
  paused: 'paused_awaiting_resume_or_input',
  question: 'provider_question',
  approval: 'provider_approval',
};

/**
 * Every open blocker for one goal, oldest first. Persisted provider rows are
 * fenced to the goal's current attempt; a confirmed pause is derived from the
 * goal row itself.
 */
export function projectGoalAttention(goal: GoalBlockerGoalState, rows: readonly GoalBlockerRow[] = []): GoalAttention {
  const blockers: GoalBlocker[] = [];
  if (isGoalPausedAwaitingOperator(goal)) blockers.push(pausedBlocker(goal));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.blocker_id) || !isCurrentGoalBlocker(goal, row)) continue;
    seen.add(row.blocker_id);
    blockers.push(providerBlocker(goal, row));
  }
  // A goal input names no question, so it can answer one only while no other is waiting.
  const answerable = blockers.filter(blocker => blocker.category === 'question' && blocker.responseActions.includes('send_input'));
  if (answerable.length > 1) {
    for (const blocker of answerable) {
      blocker.responseActions = blocker.responseActions.filter(action => action !== 'send_input');
      blocker.actionable = blocker.responseActions.length > 0;
      blocker.responseHint = SEVERAL_QUESTIONS_HINT;
    }
  }
  blockers.sort((a, b) => (Date.parse(a.firstObservedAt ?? '') || 0) - (Date.parse(b.firstObservedAt ?? '') || 0)
    || a.id.localeCompare(b.id));
  return {
    waitingForOperator: blockers.length > 0,
    reason: blockers[0] ? ATTENTION_REASON[blockers[0].category] : null,
    blockers,
  };
}

/** One line for compact listings and digests. */
export function goalBlockerHeadline(blocker: Pick<GoalBlocker, 'category'>): string {
  if (blocker.category === 'question') return 'Goal asked a question';
  if (blocker.category === 'approval') return 'Goal is waiting for an approval';
  return 'Goal paused, awaiting input';
}
