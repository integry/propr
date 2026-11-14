import type { Knex } from 'knex';
import {
  PLUGIN_LOG_LIMITS, PluginSdkError, defaultPluginSettings, validatePluginSettings,
  type PluginContext, type PluginHttpFetch, type PluginInstallationRecord, type PluginJsonValue, type PluginLogLevel, type PluginLogLine,
  type PluginLogger, type PluginManifest, type PluginPermission,
} from '@propr/shared';
import logger from '../utils/logger.js';
import type { ExtensionLookup } from '../extensions/endpointPolicy.js';
import { redactExtensionOutput } from '../extensions/extensionOutput.js';
import { createPluginHttp, type PluginHttpTransport } from './pluginHttp.js';
import { githubPluginProprBackend } from './pluginProprBackend.js';
import { pluginActor, scopedProprClient, type PluginProprBackend, type PluginProprCallRecord } from './pluginProprClient.js';
import { pluginStateStore, requireInstallation, type PluginStateWriteGuard } from './pluginStateStore.js';

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
}

/** What building a context returns besides `ctx`: the captured log and redaction of anything returned to the caller. */
export interface BuiltPluginContext {
  ctx: PluginContext;
  logs: PluginLogLine[];
  /** Redact a value for the caller: connection credentials used in this run and the general secret patterns. */
  redact<T>(value: T): T;
}

/** Permissions the handler has: granted by the administrator and still asked for by the current manifest. */
export function effectivePluginPermissions(manifest: PluginManifest, record: PluginInstallationRecord): PluginPermission[] {
  return manifest.permissions.filter(permission => record.grantedPermissions.includes(permission));
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

/** The connection secret of the installation `guard` names, read in one transaction with that installation; refused once it was removed or replaced. */
async function defaultConnectionSecret({ database, environment }: { database: Knex; environment: NodeJS.ProcessEnv }, pluginId: string, connection: string, guard: PluginStateWriteGuard): Promise<string | null> {
  const { PluginStore } = await import('./pluginStore.js');
  const store = new PluginStore(database, environment);
  return database.transaction(async trx => {
    await requireInstallation(trx, pluginId, guard);
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
  const logs: PluginLogLine[] = [];
  const redact = <T>(value: T): T => redactExtensionOutput(value, credentials) as T;
  let dropped = false;

  const write = (level: PluginLogLevel, message: unknown, fields?: Record<string, unknown>) => {
    if (signal.aborted) return;
    if (logs.length >= PLUGIN_LOG_LIMITS.lines) {
      if (!dropped) { dropped = true; logs.push({ level: 'warn', message: `Log limit of ${PLUGIN_LOG_LIMITS.lines} lines reached; later lines were dropped`, at: now() }); }
      return;
    }
    const text = String(message).slice(0, PLUGIN_LOG_LIMITS.messageChars);
    const json = logFields(fields);
    logs.push({ level, message: redact(text), ...(json ? { fields: redact(json) } : {}), at: now() });
  };
  const log: PluginLogger = { debug: (m, f) => write('debug', m, f), info: (m, f) => write('info', m, f), warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f) };

  const recordCall = async (call: PluginProprCallRecord) => {
    const { allowed, ...detail } = call;
    await deps.database('plugin_audit').insert({
      plugin_id: pluginId, action: allowed ? 'handler_call' : 'handler_refused', actor: pluginActor(pluginId), at: now(),
      detail: JSON.stringify({ handler, ...detail }),
    });
    if (!allowed) {
      write('warn', `ctx.propr.${call.operation} refused: ${call.reason}`, { operation: call.operation, permission: call.permission, reason: call.reason ?? null, ...(call.repository ? { repository: call.repository } : {}) });
      logger.warn({ pluginId, handler, operation: call.operation, reason: call.reason }, '[plugins] Handler call refused');
    }
  };

  // The installation this run belongs to: a credential is read from it only, and a request is sent only while it is still installed.
  const installation: PluginStateWriteGuard = { installedAt: record.installedAt, signal };
  /** Refuses once this run's installation was uninstalled (or replaced by a reinstall), or the run ended. */
  const authorizeInstallation = () => deps.database.transaction(trx => requireInstallation(trx, pluginId, installation));
  const http = (connection?: string): PluginHttpFetch => {
    let credential: (() => Promise<string>) | undefined;
    if (connection !== undefined) {
      const declared = manifest.connections.find(c => c.name === connection);
      if (!declared) throw new PluginSdkError('connection_unavailable', `The plugin declares no connection ${String(connection).slice(0, 48)}`);
      if (declared.type !== 'token') throw new PluginSdkError('connection_unavailable', `Connection ${connection} is ${declared.type}; ctx.http injects token connections only`);
      credential = async () => {
        const secret = await (deps.connectionSecret ?? ((id, name) => defaultConnectionSecret({ database: deps.database, environment }, id, name, installation)))(pluginId, connection);
        if (!secret) throw new PluginSdkError('connection_unavailable', `Connection ${connection} is not set`);
        credentials.push(secret);
        return secret;
      };
    }
    return createPluginHttp({
      outboundHosts: manifest.outboundHosts, credential, lookup: deps.lookup, transport: deps.transport, signal,
      authorize: credential ? authorizeInstallation : undefined,
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
    settings: Object.freeze(structuredClone(handlerSettings(manifest, record))),
    repositories: record.repositories ? [...record.repositories] : null,
    // Its permissions and repository limit are this installation's: every call (and, by default, every GitHub request and queued task) requires it to still be installed.
    propr: liveMethods(scopedProprClient({
      pluginId, grantedPermissions: effectivePluginPermissions(manifest, record), repositories: record.repositories,
      backend: deps.backend ?? githubPluginProprBackend({ database: deps.database, signal, authorize: authorizeInstallation }), record: recordCall,
      authorize: authorizeInstallation,
    })),
    http: connection => live(http(connection)),
    // State is tied to this installation: once it is uninstalled (or replaced by a reinstall) every operation is refused.
    state: liveMethods(pluginStateStore(deps.database, pluginId, now, { installedAt: record.installedAt, signal })),
    log: Object.freeze(log),
    signal,
  };
  return { ctx: Object.freeze(ctx), logs, redact };
}
