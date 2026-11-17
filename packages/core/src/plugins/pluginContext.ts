import type { Knex } from 'knex';
import {
  PLUGIN_LOG_LIMITS, PluginSdkError, defaultPluginSettings, pluginOutboundHosts, validatePluginSettings,
  type PluginContext, type PluginHttpFetch, type PluginInstallationRecord, type PluginJsonValue, type PluginLogLevel, type PluginLogLine,
  type PluginAuditAction, type PluginLogger, type PluginManifest, type PluginPermission, type PluginSecretUrl,
} from '@propr/shared';
import logger from '../utils/logger.js';
import type { ExtensionLookup } from '../extensions/endpointPolicy.js';
import { redactExtensionOutput } from '../extensions/extensionOutput.js';
import { createPluginHttp, scrubCredentialValues, secretUrlCredentials, type PluginHttpTransport } from './pluginHttp.js';
import { githubPluginProprBackend } from './pluginProprBackend.js';
import { pluginActor, scopedProprClient, type PluginProprBackend, type PluginProprCallOutcome, type PluginProprCallRecord, type PluginProprCallScope } from './pluginProprClient.js';
import { pluginStateStore, requireInstallation, type PluginInstallationAuthority, type PluginStateWriteGuard } from './pluginStateStore.js';

/** An installed plugin as a handler runs it: the current manifest and the installation record. */
export interface PluginInstallationTarget { pluginId: string; manifest: PluginManifest; record: PluginInstallationRecord }

export interface PluginContextDeps {
  database: Knex;
  environment?: NodeJS.ProcessEnv;
  /** The ProPR services behind `ctx.propr`; defaults to GitHub, the event journal and the task queue. */
  backend?: PluginProprBackend;
  /** The stored secret of a connection; defaults to the plugin store's sealed connection secrets. */
  connectionSecret?: (pluginId: string, connection: string) => Promise<string | null>;
  lookup?: ExtensionLookup;
  transport?: PluginHttpTransport;
  now?: () => number;
  /**
   * Run for an installation that is not enabled: an `optionsFrom` handler
   * loading a setting's choices while the plugin is being configured. The
   * installation must still be the one the run started with.
   */
  allowDisabled?: boolean;
}

/** What building a context returns besides `ctx`: the captured log and redaction of anything returned to the caller. */
export interface BuiltPluginContext {
  ctx: PluginContext;
  /** The log lines for the caller: each redacted again with every credential of the run, then cut to `PLUGIN_LOG_LIMITS.messageChars`. */
  finalLogs(): PluginLogLine[];
  /** Redact a value for the caller: connection credentials used in this run (in every spelling, percent-escaped too) and the general secret patterns. */
  redact<T>(value: T): T;
  /** Redact `text` (kept with `retainForRedaction`), then cut it to `limit` characters, withholding a credential the cut would leave partly visible. */
  clip(text: string, limit: number): string;
}

/**
 * Characters of a message kept past its length limit until the run's final
 * redaction. A credential that straddles the limit (and may only be acquired
 * after the line was written) is then still matched whole and redacted before
 * the message is cut, rather than cut first and left one character short. It
 * covers every spelling of a storable connection secret (at most 4,096
 * characters, `PLUGIN_SECRET_PATTERN`): the hex of its header value, each
 * character percent-escaped, is about 24,600 characters.
 */
const REDACTION_MARGIN_CHARS = 32 * 1024;
/** `text` as kept for a later redaction and cut to `limit`: `limit` characters and the margin. */
export const retainForRedaction = (text: string, limit: number): string => text.slice(0, limit + REDACTION_MARGIN_CHARS);

/** The raw spellings of a credential whose start a cut message could end with (`[spelling, any letter case]`). */
function cutSpellings(secret: string): [string, boolean][] {
  return [secret, `Bearer ${secret}`].flatMap(value => [
    [value, false], [Buffer.from(value).toString('base64'), false], [Buffer.from(value).toString('base64url'), false],
    [encodeURIComponent(value), false], [Buffer.from(value).toString('hex'), true],
  ] as [string, boolean][]);
}
/** How many trailing characters of `text` begin a credential spelling: a credential longer than the margin, cut at the limit. */
function cutCredentialTail(text: string, credentials: readonly string[]): number {
  let longest = 0;
  const folded = text.toLowerCase();
  for (const [spelling, anyCase] of credentials.filter(Boolean).flatMap(cutSpellings)) {
    const haystack = anyCase ? folded : text;
    for (let length = Math.min(spelling.length - 1, haystack.length); length > longest; length--) {
      if (haystack.endsWith(spelling.slice(0, length))) { longest = length; break; }
    }
  }
  return longest;
}

/** The audit action of each recorded `ctx.propr` call outcome. */
const CALL_AUDIT_ACTIONS = { attempted: 'handler_attempt', completed: 'handler_call', refused: 'handler_refused' } as const satisfies Record<PluginProprCallOutcome, PluginAuditAction>;

/** Permissions the handler has: granted by the administrator and still asked for by the current manifest. */
export function effectivePluginPermissions(manifest: PluginManifest, record: Pick<PluginInstallationRecord, 'grantedPermissions'>): PluginPermission[] {
  return manifest.permissions.filter(permission => record.grantedPermissions.includes(permission));
}

/** The installation as it is now, required to be the one the run started with (not a reinstall) and enabled. */
async function currentInstallation(database: Knex, pluginId: string, installation: PluginStateWriteGuard, allowDisabled = false): Promise<PluginInstallationAuthority> {
  const authority = await database.transaction(trx => requireInstallation(trx, pluginId, installation));
  if (!authority.enabled && !allowDisabled) throw new PluginSdkError('unavailable', 'The plugin is disabled');
  return authority;
}

/**
 * Authorization of a run's dispatches against its installation as it is at
 * that moment, not as the run started: an administrator may have disabled the
 * plugin, uninstalled it (or reinstalled it), changed its repository limit or
 * its grants while the handler was suspended. `request` is for an
 * authenticated `ctx.http` request: the installation must be the same and
 * enabled. `call` is for a `ctx.propr` dispatch: it must also still grant the
 * permission (through the run's manifest) and, when the call names a
 * repository, still allow it.
 */
// eslint-disable-next-line max-params -- the database, plugin, manifest, installation and disabled allowance are explicit inputs
export function installationAuthorizer(database: Knex, pluginId: string, manifest: PluginManifest, installation: PluginStateWriteGuard, allowDisabled = false) {
  return {
    request: async (): Promise<void> => { await currentInstallation(database, pluginId, installation, allowDisabled); },
    call: async ({ permission, repository }: PluginProprCallScope): Promise<void> => {
      const authority = await currentInstallation(database, pluginId, installation, allowDisabled);
      if (!effectivePluginPermissions(manifest, authority).includes(permission)) throw new PluginSdkError('permission_denied', `The ${permission} permission is no longer granted to this plugin`);
      if (repository && authority.repositories && !authority.repositories.some(allowed => allowed.toLowerCase() === repository.toLowerCase())) {
        throw new PluginSdkError('repository_not_allowed', `This plugin is no longer enabled for ${repository}`);
      }
    },
  };
}

/** The installation's settings with the manifest's defaults, validated against the current manifest. */
export function handlerSettings(manifest: PluginManifest, record: PluginInstallationRecord) {
  const result = validatePluginSettings(manifest.settings, { ...defaultPluginSettings(manifest.settings), ...record.settings });
  if (!result.ok) throw new PluginSdkError('invalid_input', `The plugin settings do not match its manifest: ${result.errors.join('; ')}`);
  return result.settings;
}

/** A JSON copy of log fields, or a marker when they are not JSON or too large. */
function logFields(fields: Record<string, unknown> | undefined): Record<string, PluginJsonValue> | undefined {
  if (fields === undefined) return undefined;
  try {
    const text = JSON.stringify(fields);
    if (text === undefined || !fields || typeof fields !== 'object') return { invalidFields: true };
    if (Buffer.byteLength(text) > PLUGIN_LOG_LIMITS.fieldsBytes) return { truncatedFields: true };
    return JSON.parse(text) as Record<string, PluginJsonValue>;
  } catch { return { invalidFields: true }; }
}

/** The connection secret of the installation `guard` names, read in one transaction with that installation; refused once it was removed, replaced or disabled. */
async function defaultConnectionSecret({ database, environment, allowDisabled }: { database: Knex; environment: NodeJS.ProcessEnv; allowDisabled: boolean }, pluginId: string, connection: string, guard: PluginStateWriteGuard): Promise<string | null> {
  const { PluginStore } = await import('./pluginStore.js');
  const store = new PluginStore(database, environment);
  return database.transaction(async trx => {
    const authority = await requireInstallation(trx, pluginId, guard);
    if (!authority.enabled && !allowDisabled) throw new PluginSdkError('unavailable', 'The plugin is disabled');
    return store.connectionSecret(pluginId, connection, trx);
  });
}

/**
 * Build `ctx` for one handler invocation. Nothing in it holds a secret: a
 * connection's credential is read only when `ctx.http(connection)` sends a
 * request, injected there and scrubbed from the response. Log lines and
 * anything returned to the caller pass the extension output redaction.
 */
export function buildPluginContext(target: PluginInstallationTarget, deps: PluginContextDeps, handler: string, signal: AbortSignal): BuiltPluginContext {
  const { pluginId, manifest, record } = target;
  const now = deps.now ?? Date.now;
  const environment = deps.environment ?? process.env;
  const credentials: string[] = [];
  // Messages are kept past their limit (`retainForRedaction`) and cut only after the final redaction: see `clip`.
  const logs: PluginLogLine[] = [];
  // The extension output redaction matches one URL-encoded spelling only; the response scrubbing also catches `%2f` and other escapes first.
  const redact = <T>(value: T): T => redactExtensionOutput(scrubCredentialValues(value, credentials), credentials) as T;
  // Redacted first, so a credential straddling the limit is replaced whole; a credential longer than the kept margin has its visible start withheld.
  const clip = (text: string, limit: number): string => {
    const redacted = redact(text);
    if (redacted.length <= limit) return redacted;
    const cut = redacted.slice(0, limit);
    return cut.slice(0, cut.length - cutCredentialTail(cut, credentials));
  };
  let dropped = false;

  const write = (level: PluginLogLevel, message: unknown, fields?: Record<string, unknown>) => {
    if (signal.aborted) return;
    if (logs.length >= PLUGIN_LOG_LIMITS.lines) {
      if (!dropped) { dropped = true; logs.push({ level: 'warn', message: `Log limit of ${PLUGIN_LOG_LIMITS.lines} lines reached; later lines were dropped`, at: now() }); }
      return;
    }
    const text = retainForRedaction(String(message), PLUGIN_LOG_LIMITS.messageChars);
    const json = logFields(fields);
    logs.push({ level, message: redact(text), ...(json ? { fields: redact(json) } : {}), at: now() });
  };
  const log: PluginLogger = { debug: (m, f) => write('debug', m, f), info: (m, f) => write('info', m, f), warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f) };

  const recordCall = async (call: PluginProprCallRecord) => {
    const { outcome, ...detail } = call;
    await deps.database('plugin_audit').insert({
      plugin_id: pluginId, action: CALL_AUDIT_ACTIONS[outcome], actor: pluginActor(pluginId), at: now(),
      detail: JSON.stringify({ handler, ...detail }),
    });
    if (outcome === 'refused') {
      write('warn', `ctx.propr.${call.operation} refused: ${call.reason}`, { operation: call.operation, permission: call.permission, reason: call.reason ?? null, ...(call.repository ? { repository: call.repository } : {}) });
      logger.warn({ pluginId, handler, operation: call.operation, reason: call.reason }, '[plugins] Handler call refused');
    }
  };

  // The installation this run belongs to: a credential is read from it only, and a request is sent only while it is still installed and enabled.
  const installation: PluginStateWriteGuard = { installedAt: record.installedAt, signal };
  /** Refuses once this run's installation was uninstalled (or replaced by a reinstall), disabled or restricted, or the run ended. */
  const allowDisabled = deps.allowDisabled === true;
  const authorize = installationAuthorizer(deps.database, pluginId, manifest, installation, allowDisabled);
  const settings = Object.freeze(structuredClone(handlerSettings(manifest, record)));
  // The manifest's hosts and those of the URL settings it names, as this run's settings have them.
  const outboundHosts = pluginOutboundHosts(manifest, settings);
  const http = (connection?: string): PluginHttpFetch => {
    let credential: (() => Promise<string>) | undefined;
    let credentialUse: 'bearer' | 'raw' | 'signature' | 'url' = 'bearer';
    let secretUrl: PluginSecretUrl | undefined;
    if (connection !== undefined) {
      const declared = manifest.connections.find(c => c.name === connection);
      if (!declared) throw new PluginSdkError('connection_unavailable', `The plugin declares no connection ${String(connection).slice(0, 48)}`);
      if (declared.type === 'oauth') throw new PluginSdkError('connection_unavailable', `Connection ${connection} is oauth; ctx.http uses token and signing_secret connections only`);
      if (declared.type === 'signing_secret') credentialUse = 'signature';
      if (declared.type === 'token' && declared.secretUrl) { credentialUse = 'url'; secretUrl = declared.secretUrl; }
      else if (declared.type === 'token' && declared.authorization === 'raw') credentialUse = 'raw';
      credential = async () => {
        const secret = await (deps.connectionSecret ?? ((id, name) => defaultConnectionSecret({ database: deps.database, environment, allowDisabled }, id, name, installation)))(pluginId, connection);
        if (!secret) throw new PluginSdkError('connection_unavailable', `Connection ${connection} is not set`);
        // A secret URL is redacted whole and by its path and query, which carry its credential.
        credentials.push(...(credentialUse === 'url' ? secretUrlCredentials(secret) : [secret]));
        return secret;
      };
    }
    return createPluginHttp({
      outboundHosts, credential, credentialUse, secretUrl, lookup: deps.lookup, transport: deps.transport, signal,
      authorize: credential ? authorize.request : undefined,
      onDecision: ({ host, allowed, reason }) => write(allowed ? 'debug' : 'warn', allowed ? `ctx.http request to ${host}` : `ctx.http request to ${host} refused: ${reason}`, { host, ...(connection ? { connection } : {}) }),
    });
  };

  // Once the run has ended (returned, failed or timed out) nothing the handler left running can act through ctx.
  const live = <A extends unknown[], R>(run: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (signal.aborted) throw new PluginSdkError('unavailable', 'This handler run has ended');
    return run(...args);
  };
  const liveMethods = <T extends object>(api: T): T => Object.freeze(Object.fromEntries(Object.entries(api).map(([name, run]) => [name, live(run as (...args: unknown[]) => Promise<unknown>)]))) as T;

  const ctx: PluginContext = {
    pluginId,
    settings,
    repositories: record.repositories ? [...record.repositories] : null,
    // Its permissions and repository limit are this installation's: every call (and, by default, every GitHub request and queued task) requires it to
    // still be installed and enabled, and to still grant the call's permission on its repository.
    propr: liveMethods(scopedProprClient({
      pluginId, grantedPermissions: effectivePluginPermissions(manifest, record), repositories: record.repositories,
      backend: deps.backend ?? githubPluginProprBackend({ database: deps.database, signal, authorize: authorize.call }), record: recordCall,
      onRecordFailure: (call, error) => logger.error({ pluginId, handler, operation: call.operation, callId: call.callId, outcome: call.outcome, error: error instanceof Error ? error.message : String(error) }, '[plugins] Could not record the outcome of an attempted handler call'),
      authorize: authorize.call,
    })),
    http: connection => live(http(connection)),
    // State is tied to this installation: once it is uninstalled (or replaced by a reinstall) every operation is refused.
    state: liveMethods(pluginStateStore(deps.database, pluginId, now, { installedAt: record.installedAt, signal })),
    log: Object.freeze(log),
    signal,
  };
  // Lines logged before a credential was acquired were redacted without it: redact every line again with all the credentials of this run, then cut it.
  const finalLogs = (): PluginLogLine[] => logs.map(line => {
    const redacted = redact(line);
    return { ...redacted, message: clip(redacted.message, PLUGIN_LOG_LIMITS.messageChars) };
  });
  return { ctx: Object.freeze(ctx), finalLogs, redact, clip };
}
