import type { PluginPermission } from './plugins.js';
import type { PluginSettingValues } from './pluginInstallations.js';
import type { RepositoryEvent, RepositoryEventDomain } from './repositoryEvents.js';

/**
 * The plugin handler SDK. A plugin folder may contain `handlers.ts` exporting
 * named async functions `(input, ctx) => result`. `ctx` is the only way a
 * handler touches anything: its settings, a ProPR client limited to the
 * installation's grant and repository limit, outbound HTTP limited to the
 * manifest's `outboundHosts`, a small key-value state store and a structured
 * log. Official plugins run in-process, but only through this interface, so
 * the same plugin can later run out of process.
 *
 * Handlers import nothing from ProPR but `@propr/shared` (these types among
 * them); a lint rule enforces this for `packages/plugins/**`.
 */

/** A handler runs at most this long; a handler still running is reported as a failure. */
export const PLUGIN_HANDLER_TIMEOUT_MS = 30_000;

/** Limits of `ctx.state`, per installation. Values are JSON; sizes are UTF-8 bytes of the serialized value. */
export const PLUGIN_STATE_LIMITS = { keys: 256, keyLength: 200, valueBytes: 16 * 1024, totalBytes: 256 * 1024 } as const;
/** Limits of `ctx.http`. */
export const PLUGIN_HTTP_LIMITS = { requestBytes: 256 * 1024, responseBytes: 1024 * 1024, timeoutMs: 10_000, headers: 64 } as const;
/** Limits of `ctx.log`: lines kept per invocation and characters per message. */
export const PLUGIN_LOG_LIMITS = { lines: 200, messageChars: 2_000, fieldsBytes: 4 * 1024 } as const;
/** Limits of text a handler writes through `ctx.propr`. */
export const PLUGIN_PROPR_LIMITS = { titleChars: 256, bodyChars: 65_536, labelChars: 50, labels: 20, events: 100 } as const;

export type PluginJsonValue = string | number | boolean | null | PluginJsonValue[] | { [key: string]: PluginJsonValue };

/** Why a `ctx` call was refused. Thrown to the handler as a `PluginSdkError`. */
export const PLUGIN_SDK_ERROR_CODES = [
  'permission_denied', 'repository_not_allowed', 'not_found', 'invalid_input',
  'host_not_allowed', 'insecure_url', 'private_address', 'connection_unavailable', 'response_too_large', 'http_failed',
  'state_limit', 'unavailable',
] as const;
export type PluginSdkErrorCode = typeof PLUGIN_SDK_ERROR_CODES[number];
export class PluginSdkError extends Error {
  readonly name = 'PluginSdkError';
  constructor(readonly code: PluginSdkErrorCode, message: string) { super(message); }
}

/** The ProPR operations `ctx.propr` offers and the permission each needs. */
export const PLUGIN_PROPR_OPERATIONS = {
  getPullRequest: 'pull_requests.read',
  getIssue: 'issues.read',
  getTask: 'tasks.read',
  listEvents: 'events.read',
  createIssue: 'issues.create',
  createTask: 'tasks.create',
  commentOnPullRequest: 'pull_requests.comment',
  commentOnIssue: 'issues.comment',
  addLabel: 'labels.write',
  removeLabel: 'labels.write',
} as const satisfies Record<string, PluginPermission>;
export type PluginProprOperation = keyof typeof PLUGIN_PROPR_OPERATIONS;

export interface PluginIssueSummary {
  repository: string; number: number; title: string; state: 'open' | 'closed'; url: string;
  labels: string[]; author: string | null; createdAt: string; updatedAt: string;
}
export interface PluginPullRequestSummary extends PluginIssueSummary {
  draft: boolean; merged: boolean; headRef: string; baseRef: string; headSha: string;
}
export interface PluginTaskSummary {
  taskId: string; repository: string; kind: string; issueNumber: number | null; prNumber: number | null;
  state: string | null; model: string | null; createdAt: string;
}
export interface PluginCreatedIssue { repository: string; number: number; url: string }
export interface PluginCreatedTask { repository: string; issueNumber: number; jobId: string }
export interface PluginCreatedComment { repository: string; number: number; id: number; url: string }
export interface PluginListEventsInput { repository: string; afterSeq?: number; domains?: RepositoryEventDomain[]; limit?: number }

/**
 * ProPR, as far as this installation may see and change it. Every call is
 * checked against the granted permissions and the repository limit and is
 * recorded with the plugin as the actor; a refused call throws a
 * `PluginSdkError` and is logged.
 */
export interface PluginProprClient {
  getPullRequest(repository: string, number: number): Promise<PluginPullRequestSummary>;
  getIssue(repository: string, number: number): Promise<PluginIssueSummary>;
  getTask(taskId: string): Promise<PluginTaskSummary>;
  listEvents(input: PluginListEventsInput): Promise<RepositoryEvent[]>;
  createIssue(repository: string, issue: { title: string; body?: string; labels?: string[] }): Promise<PluginCreatedIssue>;
  /** Start an ordinary one-shot task for an issue. Handlers never interact with a running task. */
  createTask(repository: string, issueNumber: number): Promise<PluginCreatedTask>;
  commentOnPullRequest(repository: string, number: number, body: string): Promise<PluginCreatedComment>;
  commentOnIssue(repository: string, number: number, body: string): Promise<PluginCreatedComment>;
  addLabel(repository: string, number: number, label: string): Promise<void>;
  removeLabel(repository: string, number: number, label: string): Promise<void>;
}

export interface PluginHttpRequestInit {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** A text body; use `json` for a JSON body. */
  body?: string;
  json?: PluginJsonValue;
}
/** A buffered response. Redirects are not followed; the connection's credential never appears in it. */
export interface PluginHttpResponse {
  status: number; ok: boolean; url: string;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}
/** `fetch`-like outbound HTTPS, limited to the manifest's `outboundHosts`. */
export type PluginHttpFetch = (url: string, init?: PluginHttpRequestInit) => Promise<PluginHttpResponse>;

/** A small key-value store scoped to the installation; deleted on uninstall. */
export interface PluginStateStore {
  get<T extends PluginJsonValue = PluginJsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: PluginJsonValue): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Keys in order, optionally only those starting with `prefix`. */
  keys(prefix?: string): Promise<string[]>;
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface PluginLogLine { level: PluginLogLevel; message: string; fields?: Record<string, PluginJsonValue>; at: number }
export type PluginLogger = Record<PluginLogLevel, (message: string, fields?: Record<string, unknown>) => void>;

export interface PluginContext {
  pluginId: string;
  /** The validated settings of the installation. */
  settings: PluginSettingValues;
  /** Repositories (`owner/repo`) the installation is limited to; `null` for all. */
  repositories: string[] | null;
  propr: PluginProprClient;
  /** Outbound HTTP; with a connection name, that connection's credential is injected. */
  http(connection?: string): PluginHttpFetch;
  state: PluginStateStore;
  log: PluginLogger;
  /** Aborted when the handler runs past its time limit. */
  signal: AbortSignal;
}

/** Handler input envelopes. The dispatcher, webhook route and commands each build one. */
/**
 * A journal event delivered to a subscribed handler. Delivery is at least
 * once: `deliveryId` is the same on every attempt (and after a worker
 * restart), so a handler with side effects can de-duplicate on it. `attempt`
 * counts from 1.
 */
export interface PluginEventInput { kind: 'event'; event: RepositoryEvent; deliveryId: string; attempt: number }
/**
 * A verified inbound webhook request delivered to its handler. `headers` are
 * the request's headers (lower-case names) without the verification headers,
 * cookies and authorization; `body` is the raw body as text. Neither is
 * stored by ProPR. `deliveryId` is the same on every attempt: the sender's
 * delivery id when the webhook declares `deliveryIdHeader`, otherwise one ProPR
 * assigns. `attempt` counts from 1.
 */
export interface PluginWebhookInput { kind: 'webhook'; webhook: string; headers: Record<string, string>; body: string; receivedAt: number; deliveryId: string; attempt: number }
/**
 * A `handler` slash command: the comment's repository (`owner/repo`), the
 * issue or pull request `number` it was posted on (`target`), the commenter's
 * login (`actor`) and the rest of the command line (`args`), which is
 * untrusted text. `deliveryId` (`cmd-<target>-<comment id>`) is the same on
 * every attempt; `attempt` counts from 1.
 */
export interface PluginCommandInput {
  kind: 'command'; command: string; args: string; repository: string; number: number; target: 'issue' | 'pull_request';
  actor: string; commentId: number; deliveryId: string; attempt: number;
}
export interface PluginInvokeInput { kind: 'invoke'; payload: PluginJsonValue }
export type PluginHandlerInput = PluginEventInput | PluginWebhookInput | PluginCommandInput | PluginInvokeInput;

/** A handler returns nothing or a small JSON result. */
export type PluginHandlerResultValue = PluginJsonValue | void;
export type PluginHandler<I extends PluginHandlerInput = PluginHandlerInput, R extends PluginHandlerResultValue = PluginHandlerResultValue> = (input: I, ctx: PluginContext) => Promise<R>;
export type PluginHandlerModule = Record<string, PluginHandler>;
/** Declare a handler with typed input; identity at runtime. */
export const definePluginHandler = <I extends PluginHandlerInput, R extends PluginHandlerResultValue = void>(handler: PluginHandler<I, R>): PluginHandler<I, R> => handler;

/** What a webhook's `respond` function receives: the verified request, frozen. It gets no `ctx`. */
export interface PluginWebhookRequest { webhook: string; headers: Readonly<Record<string, string>>; body: string; receivedAt: number }
/** A synchronous answer: sent as the response, and the handler does not run. */
export interface PluginWebhookResponse {
  /** 200 by default; a 2xx status. */
  status?: number;
  /** `text/plain` by default; `application/json` for a JSON body. */
  contentType?: 'text/plain' | 'application/json';
  /** At most `PLUGIN_WEBHOOK_LIMITS.responseBytes`. */
  body: string;
}
/**
 * A webhook's `respond` function: a pure, synchronous function of the
 * request, for services that require an immediate challenge echo (Slack's
 * `url_verification`). Return a response to answer with it (the handler does
 * not run), or null to deliver the request to the handler as usual.
 */
export type PluginWebhookResponder = (request: PluginWebhookRequest) => PluginWebhookResponse | null | undefined;
/** Declare a webhook `respond` function; identity at runtime. */
export const definePluginWebhookResponder = (responder: PluginWebhookResponder): PluginWebhookResponder => responder;
/** Limits of inbound webhooks: the raw body size, the response a `respond` function may give, the delivery id length and Slack's timestamp tolerance. */
export const PLUGIN_WEBHOOK_LIMITS = { bodyBytes: 256 * 1024, responseBytes: 4 * 1024, deliveryIdChars: 200, timestampToleranceSeconds: 5 * 60, pending: 1_000 } as const;

/** What `runPluginHandler` returns; it never throws. */
export interface PluginHandlerRun {
  outcome: 'succeeded' | 'failed';
  /** The handler ran past `PLUGIN_HANDLER_TIMEOUT_MS`. */
  timedOut: boolean;
  durationMs: number;
  /** Redacted; null when the handler succeeded. */
  error: string | null;
  logs: PluginLogLine[];
  /** The handler's result, redacted, when it succeeded and returned one. */
  result?: PluginJsonValue;
}
