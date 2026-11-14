import {
  PLUGIN_PERMISSIONS, PLUGIN_PROPR_OPERATIONS, PLUGIN_STATE_LIMITS, PluginSdkError,
  type PluginContext, type PluginHttpRequestInit, type PluginHttpResponse, type PluginJsonValue, type PluginLogLevel, type PluginLogLine,
  type PluginPermission, type PluginProprClient, type PluginProprOperation, type PluginSettingValues,
} from '@propr/shared';

/**
 * A fake `ctx` for plugin unit tests: `ctx.propr` calls are recorded (and
 * answered by the test), `ctx.http` answers from scripted responses, state is
 * in memory with the real limits and log lines are captured. Like the real
 * context, a call outside the granted permissions or the repository limit
 * throws a `PluginSdkError`, and so does a request to a host the plugin does
 * not list or over plain HTTP.
 */

export interface RecordedProprCall { operation: PluginProprOperation; args: unknown[] }
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
  /** The manifest's `outboundHosts`; any host when omitted. */
  outboundHosts?: readonly string[];
  /** Connection names `ctx.http(connection)` accepts; any when omitted. */
  connections?: readonly string[];
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
  const calls: RecordedProprCall[] = []; const requests: RecordedHttpRequest[] = []; const logs: PluginLogLine[] = [];
  const state = new Map(Object.entries(structuredClone(options.state ?? {})));
  const scripts: { matcher: Matcher; answer: ScriptedHttpResponse | ((url: string, init: PluginHttpRequestInit) => ScriptedHttpResponse) }[] = [];

  const propr = Object.fromEntries((Object.keys(PLUGIN_PROPR_OPERATIONS) as PluginProprOperation[]).map(operation => [operation, async (...args: unknown[]) => {
    const permission = PLUGIN_PROPR_OPERATIONS[operation];
    if (!granted.includes(permission)) throw new PluginSdkError('permission_denied', `${operation} needs the ${permission} permission`);
    const repository = operation === 'getTask' ? null : operation === 'listEvents' ? (args[0] as { repository?: string })?.repository : args[0];
    if (limit && typeof repository === 'string' && !limit.includes(repository.toLowerCase())) throw new PluginSdkError('repository_not_allowed', `This plugin is not enabled for ${repository}`);
    calls.push({ operation, args: structuredClone(args) });
    const answer = options.propr?.[operation] as ((...a: unknown[]) => unknown) | undefined;
    return answer ? answer(...args) : (placeholders[operation] as (...a: unknown[]) => unknown)(...args);
  }])) as unknown as PluginProprClient;

  const http = (connection?: string) => {
    if (connection !== undefined && options.connections && !options.connections.includes(connection)) throw new PluginSdkError('connection_unavailable', `No connection ${connection}`);
    return async (url: string, init: PluginHttpRequestInit = {}) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new PluginSdkError('invalid_input', 'Invalid URL'); }
      if (parsed.protocol !== 'https:') throw new PluginSdkError('insecure_url', 'Only https:// URLs are allowed');
      if (options.outboundHosts && !options.outboundHosts.includes(parsed.hostname)) throw new PluginSdkError('host_not_allowed', `${parsed.hostname} is not an outbound host`);
      requests.push({ url, init: structuredClone(init), connection: connection ?? null });
      const script = [...scripts].reverse().find(s => matches(s.matcher, url, init));
      if (!script) throw new PluginSdkError('http_failed', `No scripted response for ${init.method ?? 'GET'} ${url}`);
      return response(url, typeof script.answer === 'function' ? script.answer(url, init) : script.answer);
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
