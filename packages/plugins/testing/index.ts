import { createHmac } from 'node:crypto';
import {
  PLUGIN_PERMISSIONS, PLUGIN_PROPR_OPERATIONS, PLUGIN_STATE_LIMITS, PluginSdkError, pluginOutboundHosts,
  type PluginContext, type PluginHttpRequestInit, type PluginHttpResponse, type PluginJsonValue, type PluginLogLevel, type PluginLogLine,
  type PluginPermission, type PluginProprClient, type PluginProprOperation, type PluginSettingValues,
} from '@propr/shared';

/**
 * A fake `ctx` for plugin unit tests: `ctx.propr` calls are recorded (and
 * answered by the test), `ctx.http` answers from scripted responses, state is
 * in memory with the real limits and log lines are captured. Like the real
 * context, a call outside the granted permissions or the repository limit
 * throws a `PluginSdkError`, and so does a request to a host the plugin does
 * not list or over plain HTTP. A request with a `signature` is signed as the
 * real `ctx.http` signs it, with the connection's secret from `secrets`.
 */

export interface RecordedProprCall { operation: PluginProprOperation; args: unknown[] }
/** A request as sent: `init.headers` include the signature header of a signed request. */
export interface RecordedHttpRequest { url: string; init: PluginHttpRequestInit; connection: string | null }
export interface ScriptedHttpResponse { status?: number; headers?: Record<string, string>; body?: string; json?: PluginJsonValue }
type Matcher = string | RegExp | ((url: string, init: PluginHttpRequestInit) => boolean);
type Answers = { [K in PluginProprOperation]?: (...args: Parameters<PluginProprClient[K]>) => Awaited<ReturnType<PluginProprClient[K]>> | Promise<Awaited<ReturnType<PluginProprClient[K]>>> };

export interface TestPluginContextOptions {
  pluginId?: string;
  settings?: PluginSettingValues;
  /** Repositories the installation is limited to; null (the default) for all. */
  repositories?: string[] | null;
  /** Granted permissions; every permission by default. */
  grantedPermissions?: readonly PluginPermission[];
  /** The manifest's `outboundHosts`; any host when omitted (and `outboundHostsFromSettings` is too). */
  outboundHosts?: readonly string[];
  /** The manifest's `outboundHostsFromSettings`: the hosts of these URL settings in `settings` are allowed too. */
  outboundHostsFromSettings?: readonly string[];
  /** Connection names `ctx.http(connection)` accepts; any when omitted. */
  connections?: readonly string[];
  /** Secrets of `signing_secret` connections, by name: a request with a `signature` is signed with its connection's secret. */
  secrets?: Record<string, string>;
  /** Answers to `ctx.propr` calls; an unanswered call resolves with a minimal placeholder. */
  propr?: Answers;
  /** Initial state. */
  state?: Record<string, PluginJsonValue>;
}

export interface TestPluginContext {
  ctx: PluginContext;
  /** Every `ctx.propr` call that passed the permission and repository checks, in order. */
  calls: RecordedProprCall[];
  /** Every `ctx.http` request, in order. */
  requests: RecordedHttpRequest[];
  logs: PluginLogLine[];
  state: Map<string, PluginJsonValue>;
  /** Answer requests matching `matcher` (a URL prefix, a pattern or a predicate) with `response`; the newest script wins. */
  respond(matcher: Matcher, response: ScriptedHttpResponse | ((url: string, init: PluginHttpRequestInit) => ScriptedHttpResponse)): void;
}

const placeholders: { [K in PluginProprOperation]: (...args: never[]) => unknown } = {
  getPullRequest: (repository: string, number: number) => ({ repository, number, title: '', state: 'open', url: '', labels: [], author: null, createdAt: '', updatedAt: '', draft: false, merged: false, headRef: '', baseRef: '', headSha: '' }),
  getIssue: (repository: string, number: number) => ({ repository, number, title: '', state: 'open', url: '', labels: [], author: null, createdAt: '', updatedAt: '' }),
  getTask: (taskId: string) => ({ taskId, repository: 'owner/repo', kind: 'implementation', issueNumber: null, prNumber: null, state: null, model: null, createdAt: '' }),
  listEvents: () => [],
  createIssue: (repository: string) => ({ repository, number: 1, url: '' }),
  createTask: (repository: string, issueNumber: number) => ({ repository, issueNumber, jobId: `issue-${repository.replace('/', '-')}-${issueNumber}` }),
  commentOnPullRequest: (repository: string, number: number) => ({ repository, number, id: 1, url: '' }),
  commentOnIssue: (repository: string, number: number) => ({ repository, number, id: 1, url: '' }),
  addLabel: () => undefined,
  removeLabel: () => undefined,
};

function matches(matcher: Matcher, url: string, init: PluginHttpRequestInit): boolean {
  if (typeof matcher === 'string') return url.startsWith(matcher);
  if (matcher instanceof RegExp) return matcher.test(url);
  return matcher(url, init);
}

function response(url: string, scripted: ScriptedHttpResponse): PluginHttpResponse {
  const status = scripted.status ?? 200;
  const text = scripted.json !== undefined ? JSON.stringify(scripted.json) : scripted.body ?? '';
  const headers = Object.fromEntries(Object.entries({ ...(scripted.json !== undefined ? { 'content-type': 'application/json' } : {}), ...scripted.headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, url, headers, text: async () => text, json: async <T>() => JSON.parse(text) as T };
}

/** Sign a request as the real `ctx.http` does: `prefix` + hex HMAC-SHA256 of `<timestamp>.<body>` (or the body). */
function signed(init: PluginHttpRequestInit, connection: string | undefined, secrets: Record<string, string> | undefined): PluginHttpRequestInit {
  const secret = connection !== undefined && secrets && Object.hasOwn(secrets, connection) ? secrets[connection] : undefined;
  if (init.signature === undefined) {
    if (secret !== undefined) throw new PluginSdkError('invalid_input', 'Requests with a signing_secret connection need a signature');
    return init;
  }
  if (secret === undefined) throw new PluginSdkError(connection === undefined ? 'invalid_input' : 'connection_unavailable', 'signature needs a signing_secret connection with a secret');
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const { header, prefix = '', timestampHeader } = init.signature;
  const timestamp = timestampHeader === undefined ? undefined : headers[timestampHeader.toLowerCase()];
  if (timestampHeader !== undefined && timestamp === undefined) throw new PluginSdkError('invalid_input', `signature.timestampHeader names ${timestampHeader}, which the request does not set`);
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.body ?? '';
  const hmac = createHmac('sha256', secret);
  if (timestamp !== undefined) hmac.update(`${timestamp}.`);
  hmac.update(body);
  return { ...init, headers: { ...headers, [header.toLowerCase()]: `${prefix}${hmac.digest('hex')}` } };
}

function stateStore(state: Map<string, PluginJsonValue>): PluginContext['state'] {
  const size = (skip?: string) => [...state].reduce((sum, [key, value]) => (key === skip ? sum : sum + Buffer.byteLength(JSON.stringify(value))), 0);
  const check = (key: unknown) => {
    if (typeof key !== 'string' || !key.length || key.length > PLUGIN_STATE_LIMITS.keyLength || !/^[\x21-\x7e]+$/.test(key)) throw new PluginSdkError('invalid_input', 'Invalid state key');
    return key;
  };
  return {
    get: async <T extends PluginJsonValue = PluginJsonValue>(key: string) => structuredClone(state.get(check(key))) as T | undefined,
    async set(key, value) {
      check(key);
      const bytes = Buffer.byteLength(JSON.stringify(value) ?? '');
      if (bytes > PLUGIN_STATE_LIMITS.valueBytes) throw new PluginSdkError('state_limit', 'State value too large');
      if (!state.has(key) && state.size + 1 > PLUGIN_STATE_LIMITS.keys) throw new PluginSdkError('state_limit', 'Too many state keys');
      if (size(key) + bytes > PLUGIN_STATE_LIMITS.totalBytes) throw new PluginSdkError('state_limit', 'State too large');
      state.set(key, structuredClone(value));
    },
    delete: async key => state.delete(check(key)),
    keys: async (prefix = '') => [...state.keys()].filter(key => key.startsWith(prefix)).sort(),
  };
}

export function createTestPluginContext(options: TestPluginContextOptions = {}): TestPluginContext {
  const granted = options.grantedPermissions ?? PLUGIN_PERMISSIONS;
  const limit = options.repositories?.map(r => r.toLowerCase()) ?? null;
  const allowed = (repository: unknown) => !limit || (typeof repository === 'string' && limit.includes(repository.toLowerCase()));
  /** An unanswered call's placeholder; a placeholder task belongs to a repository inside the limit. */
  const placeholder = (operation: PluginProprOperation, args: unknown[]) => {
    const value = (placeholders[operation] as (...a: unknown[]) => unknown)(...args);
    return operation === 'getTask' && options.repositories?.length ? { ...(value as object), repository: options.repositories[0] } : value;
  };
  const calls: RecordedProprCall[] = []; const requests: RecordedHttpRequest[] = []; const logs: PluginLogLine[] = [];
  const state = new Map(Object.entries(structuredClone(options.state ?? {})));
  const scripts: { matcher: Matcher; answer: ScriptedHttpResponse | ((url: string, init: PluginHttpRequestInit) => ScriptedHttpResponse) }[] = [];

  const propr = Object.fromEntries((Object.keys(PLUGIN_PROPR_OPERATIONS) as PluginProprOperation[]).map(operation => [operation, async (...args: unknown[]) => {
    const permission = PLUGIN_PROPR_OPERATIONS[operation];
    if (!granted.includes(permission)) throw new PluginSdkError('permission_denied', `${operation} needs the ${permission} permission`);
    const repository = operation === 'getTask' ? null : operation === 'listEvents' ? (args[0] as { repository?: string })?.repository : args[0];
    if (typeof repository === 'string' && !allowed(repository)) throw new PluginSdkError('repository_not_allowed', `This plugin is not enabled for ${repository}`);
    const call: RecordedProprCall = { operation, args: structuredClone(args) };
    calls.push(call);
    const answer = options.propr?.[operation] as ((...a: unknown[]) => unknown) | undefined;
    const result = await (answer ? answer(...args) : placeholder(operation, args));
    if (operation === 'getTask') {
      // Like the real getTask: the task's repository is known only once it is read, and a task outside the limit is not returned.
      if (!result) throw new PluginSdkError('not_found', 'Task not found');
      if (!allowed((result as { repository?: unknown }).repository)) {
        // Refused by the repository check, so not one of `calls`.
        calls.splice(calls.indexOf(call), 1);
        throw new PluginSdkError('repository_not_allowed', 'This plugin is not enabled for the task\'s repository');
      }
    }
    return result;
  }])) as unknown as PluginProprClient;

  // The manifest's hosts and those of its URL settings, as the real context derives them; any host when neither is given.
  const hosts = options.outboundHosts || options.outboundHostsFromSettings
    ? pluginOutboundHosts({ outboundHosts: [...options.outboundHosts ?? []], outboundHostsFromSettings: [...options.outboundHostsFromSettings ?? []] }, options.settings ?? {})
    : null;
  const http = (connection?: string) => {
    if (connection !== undefined && options.connections && !options.connections.includes(connection)) throw new PluginSdkError('connection_unavailable', `No connection ${connection}`);
    return async (url: string, init: PluginHttpRequestInit = {}) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new PluginSdkError('invalid_input', 'Invalid URL'); }
      if (parsed.protocol !== 'https:') throw new PluginSdkError('insecure_url', 'Only https:// URLs are allowed');
      if (hosts && !hosts.includes(parsed.hostname)) throw new PluginSdkError('host_not_allowed', `${parsed.hostname} is not an outbound host`);
      const sent = signed(init, connection, options.secrets);
      requests.push({ url, init: structuredClone(sent), connection: connection ?? null });
      const script = [...scripts].reverse().find(s => matches(s.matcher, url, sent));
      if (!script) throw new PluginSdkError('http_failed', `No scripted response for ${init.method ?? 'GET'} ${url}`);
      return response(url, typeof script.answer === 'function' ? script.answer(url, sent) : script.answer);
    };
  };

  const write = (level: PluginLogLevel) => (message: string, fields?: Record<string, unknown>) => {
    logs.push({ level, message: String(message), ...(fields ? { fields: JSON.parse(JSON.stringify(fields)) as Record<string, PluginJsonValue> } : {}), at: Date.now() });
  };

  const ctx: PluginContext = {
    pluginId: options.pluginId ?? 'test-plugin',
    settings: structuredClone(options.settings ?? {}),
    repositories: options.repositories ? [...options.repositories] : null,
    propr, http, state: stateStore(state),
    log: { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') },
    signal: new AbortController().signal,
  };
  return { ctx, calls, requests, logs, state, respond: (matcher, answer) => { scripts.push({ matcher, answer }); } };
}
