import { randomUUID } from 'node:crypto';
import {
  PLUGIN_PROPR_LIMITS, PLUGIN_PROPR_OPERATIONS, PLUGIN_REPOSITORY_PATTERN, PluginSdkError, REPOSITORY_EVENT_DOMAINS,
  type PluginCreatedComment, type PluginCreatedIssue, type PluginCreatedTask, type PluginIssueSummary, type PluginListEventsInput,
  type PluginPermission, type PluginProprClient, type PluginProprOperation, type PluginPullRequestSummary, type PluginTaskSummary,
  type RepositoryEvent,
} from '@propr/shared';

/**
 * What `ctx.propr` is built on: the ProPR services, unscoped. The scoped
 * client checks every call before it reaches the backend; the backend never
 * sees a call the installation may not make.
 */
export interface PluginProprBackend {
  getPullRequest(repository: string, number: number): Promise<PluginPullRequestSummary>;
  getIssue(repository: string, number: number): Promise<PluginIssueSummary>;
  /** Null when there is no such task. */
  getTask(taskId: string): Promise<PluginTaskSummary | null>;
  listEvents(input: Required<Pick<PluginListEventsInput, 'repository' | 'limit'>> & PluginListEventsInput): Promise<RepositoryEvent[]>;
  createIssue(repository: string, issue: { title: string; body: string; labels: string[] }): Promise<PluginCreatedIssue>;
  /** Queue an ordinary task for an issue; `requestedBy` is recorded on the task. */
  createTask(repository: string, issueNumber: number, attribution: { requestedBy: string }): Promise<PluginCreatedTask>;
  /** Comment on `number`, which must be of the `target` kind; otherwise throws `not_found` and posts nothing. */
  comment(repository: string, number: number, body: string, target: PluginCommentTarget): Promise<PluginCreatedComment>;
  addLabel(repository: string, number: number, label: string): Promise<void>;
  removeLabel(repository: string, number: number, label: string): Promise<void>;
}

/** What a comment operation's permission covers: issues (`issues.comment`) or pull requests (`pull_requests.comment`). */
export type PluginCommentTarget = 'issue' | 'pull_request';

/**
 * How far a recorded call got. `attempted`: a mutation passed every check and
 * is about to be dispatched; it is recorded before the backend is called.
 * `completed`: the backend returned. `refused`: refused, or the backend failed.
 */
export type PluginProprCallOutcome = 'attempted' | 'completed' | 'refused';

/** One `ctx.propr` call as recorded in the plugin audit trail. */
export interface PluginProprCallRecord {
  operation: PluginProprOperation; permission: PluginPermission; outcome: PluginProprCallOutcome;
  /** Shared by the records of one call: a mutation's attempt and its completion or refusal. */
  callId: string;
  repository?: string; number?: number; taskId?: string;
  /** Why the call was refused or failed: a `PluginSdkError` code. */
  reason?: string;
}

/** Operations that change something outside ProPR's audit trail (GitHub, the task queue): recorded as attempted before they are dispatched. */
export const PLUGIN_PROPR_MUTATIONS: ReadonlySet<PluginProprOperation> = new Set(['createIssue', 'createTask', 'commentOnPullRequest', 'commentOnIssue', 'addLabel', 'removeLabel']);

export interface ScopedProprOptions {
  pluginId: string;
  grantedPermissions: readonly PluginPermission[];
  /** The installation's repository limit; null for all repositories. */
  repositories: readonly string[] | null;
  backend: PluginProprBackend;
  /**
   * Records the call with the plugin as the actor. A mutation is dispatched
   * only once its `attempted` record is written: a failure to write it
   * refuses the call. After that, a failure to record the mutation's outcome
   * is reported through `onRecordFailure` and does not change the call's
   * result (the mutation may have happened; the attempt attributes it). For a
   * read, a failure to record fails the call.
   */
  record: (call: PluginProprCallRecord) => Promise<void>;
  /** Told when the outcome of an already attempted mutation could not be recorded. */
  onRecordFailure?: (call: PluginProprCallRecord, error: unknown) => void;
  /**
   * Called before every call reaches the backend, after its own checks, with
   * the permission the call needs and the repository it names: throws to
   * refuse it (the installation the permissions and repository limit were
   * read from was removed, replaced, disabled, or no longer grants them).
   * `getTask` names no repository until the task is read: it is called again
   * then, with the task's repository, before the task is returned.
   */
  authorize?: (call: PluginProprCallScope) => Promise<void>;
}

/** What a dispatch needs the installation to authorize right now: a permission, on a repository when the call names one. */
export interface PluginProprCallScope { permission: PluginPermission; repository?: string }

/** The actor ProPR records for anything a plugin's handler does. */
export const pluginActor = (pluginId: string) => `plugin:${pluginId}`;
/** Appended to text a plugin writes to GitHub, so a comment or issue names the plugin that wrote it. */
export const pluginAttributionMarker = (pluginId: string) => `<!-- propr-plugin:${pluginId} -->`;

type Target = { repository?: string; number?: number; taskId?: string };

function text(value: unknown, what: string, max: number, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new PluginSdkError('invalid_input', `${what} must be ${required ? '1' : '0'} to ${max} characters`);
  return value;
}
function positive(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new PluginSdkError('invalid_input', `${what} must be a positive whole number`);
  return value as number;
}
function labels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PLUGIN_PROPR_LIMITS.labels) throw new PluginSdkError('invalid_input', `labels must be a list of at most ${PLUGIN_PROPR_LIMITS.labels}`);
  return value.map(label => text(label, 'A label', PLUGIN_PROPR_LIMITS.labelChars));
}

function eventQuery(input: PluginListEventsInput): Pick<PluginListEventsInput, 'afterSeq' | 'domains'> {
  const { afterSeq, domains } = input;
  if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) throw new PluginSdkError('invalid_input', 'afterSeq must be a whole number of at least 0');
  if (domains !== undefined && (!Array.isArray(domains) || domains.length > REPOSITORY_EVENT_DOMAINS.length || domains.some(d => !(REPOSITORY_EVENT_DOMAINS as readonly string[]).includes(d)))) {
    throw new PluginSdkError('invalid_input', `domains must list journal domains: ${REPOSITORY_EVENT_DOMAINS.join(', ')}`);
  }
  return { ...(afterSeq !== undefined ? { afterSeq } : {}), ...(domains ? { domains: [...domains] } : {}) };
}

/**
 * `ctx.propr`: the ProPR operations the installation's granted permissions
 * allow, on the repositories its limit allows. Every call is recorded with
 * the plugin as the actor; a refused call is recorded and throws.
 */
export function scopedProprClient(options: ScopedProprOptions): PluginProprClient {
  const { pluginId, backend } = options;
  const limit = options.repositories?.map(r => r.toLowerCase()) ?? null;
  const withMarker = (body: string) => `${body}\n\n${pluginAttributionMarker(pluginId)}`;

  const repository = (value: unknown): string => {
    if (typeof value !== 'string' || !PLUGIN_REPOSITORY_PATTERN.test(value)) throw new PluginSdkError('invalid_input', 'repository must be owner/repo');
    return value;
  };
  const allowedRepository = (name: string) => !limit || limit.includes(name.toLowerCase());
  /** The current installation's authority over a task's repository; the refusal names no repository, as the handler did not. */
  const authorizeTaskRepository = async (name: string) => {
    if (!options.authorize) return;
    try {
      await options.authorize({ permission: PLUGIN_PROPR_OPERATIONS.getTask, repository: name });
    } catch (error) {
      if (error instanceof PluginSdkError && error.code === 'repository_not_allowed') throw new PluginSdkError('repository_not_allowed', 'This plugin is no longer enabled for the task\'s repository');
      throw error;
    }
  };

  async function call<T>(operation: PluginProprOperation, target: () => Target, run: (checked: Target) => Promise<T>): Promise<T> {
    const permission = PLUGIN_PROPR_OPERATIONS[operation];
    const callId = randomUUID();
    let checked: Target = {};
    let attempted = false;
    let result: T;
    const entry = (outcome: PluginProprCallOutcome, reason?: string): PluginProprCallRecord => ({ operation, permission, outcome, callId, ...checked, ...(reason ? { reason } : {}) });
    /** Once a mutation's attempt is recorded, its outcome record is best effort: the attempt already attributes it. */
    const recordOutcome = async (call: PluginProprCallRecord) => {
      if (!attempted) return options.record(call);
      try { await options.record(call); } catch (error) { options.onRecordFailure?.(call, error); }
    };
    try {
      if (!options.grantedPermissions.includes(permission)) throw new PluginSdkError('permission_denied', `${operation} needs the ${permission} permission, which is not granted to this plugin`);
      checked = target();
      if (checked.repository && !allowedRepository(checked.repository)) throw new PluginSdkError('repository_not_allowed', `This plugin is not enabled for ${checked.repository}`);
      // The checks above use the installation as the run started: it must still be that installation, and still authorize this call.
      if (options.authorize) await options.authorize({ permission, ...(checked.repository ? { repository: checked.repository } : {}) });
      if (PLUGIN_PROPR_MUTATIONS.has(operation)) {
        // Attributed before it is dispatched: a mutation the audit trail cannot name is never sent.
        try { await options.record(entry('attempted')); } catch { throw new PluginSdkError('unavailable', `ProPR could not record ${operation}, so it was not sent`); }
        attempted = true;
      }
      result = await run(checked);
    } catch (error) {
      // A backend failure reaches the handler without its details (they can name other repositories or carry tokens).
      const refused = error instanceof PluginSdkError ? error : new PluginSdkError('unavailable', `ProPR could not complete ${operation}`);
      await recordOutcome(entry('refused', refused.code));
      throw refused;
    }
    await recordOutcome(entry('completed'));
    return result;
  }

  return {
    getPullRequest: (repo, number) => call('getPullRequest', () => ({ repository: repository(repo), number: positive(number, 'number') }),
      t => backend.getPullRequest(t.repository!, t.number!)),
    getIssue: (repo, number) => call('getIssue', () => ({ repository: repository(repo), number: positive(number, 'number') }),
      t => backend.getIssue(t.repository!, t.number!)),
    getTask: taskId => call('getTask', () => ({ taskId: text(taskId, 'taskId', 255) }), async t => {
      const task = await backend.getTask(t.taskId!);
      if (!task) throw new PluginSdkError('not_found', 'Task not found');
      // The repository is known only once the task is read; a task outside the limit is not returned.
      if (!allowedRepository(task.repository)) throw new PluginSdkError('repository_not_allowed', 'This plugin is not enabled for the task\'s repository');
      // The call's authorization named no repository (none was known): the installation must still allow this one now, not only as the run started.
      await authorizeTaskRepository(task.repository);
      return task;
    }),
    listEvents: input => call('listEvents', () => ({ repository: repository(input?.repository) }), t => backend.listEvents({
      repository: t.repository!, ...eventQuery(input),
      limit: Math.min(Math.max(Math.trunc(Number(input.limit ?? PLUGIN_PROPR_LIMITS.events)) || 1, 1), PLUGIN_PROPR_LIMITS.events),
    })),
    createIssue: (repo, issue) => call('createIssue', () => ({ repository: repository(repo) }), t => backend.createIssue(t.repository!, {
      title: text(issue?.title, 'title', PLUGIN_PROPR_LIMITS.titleChars),
      body: withMarker(text(issue?.body, 'body', PLUGIN_PROPR_LIMITS.bodyChars, false)),
      labels: labels(issue?.labels),
    })),
    createTask: (repo, issueNumber) => call('createTask', () => ({ repository: repository(repo), number: positive(issueNumber, 'issueNumber') }),
      t => backend.createTask(t.repository!, t.number!, { requestedBy: pluginActor(pluginId) })),
    commentOnPullRequest: (repo, number, body) => call('commentOnPullRequest', () => ({ repository: repository(repo), number: positive(number, 'number') }),
      t => backend.comment(t.repository!, t.number!, withMarker(text(body, 'body', PLUGIN_PROPR_LIMITS.bodyChars)), 'pull_request')),
    commentOnIssue: (repo, number, body) => call('commentOnIssue', () => ({ repository: repository(repo), number: positive(number, 'number') }),
      t => backend.comment(t.repository!, t.number!, withMarker(text(body, 'body', PLUGIN_PROPR_LIMITS.bodyChars)), 'issue')),
    addLabel: (repo, number, label) => call('addLabel', () => ({ repository: repository(repo), number: positive(number, 'number') }),
      t => backend.addLabel(t.repository!, t.number!, text(label, 'label', PLUGIN_PROPR_LIMITS.labelChars))),
    removeLabel: (repo, number, label) => call('removeLabel', () => ({ repository: repository(repo), number: positive(number, 'number') }),
      t => backend.removeLabel(t.repository!, t.number!, text(label, 'label', PLUGIN_PROPR_LIMITS.labelChars))),
  };
}
