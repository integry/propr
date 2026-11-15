import type { Knex } from 'knex';
import {
  PLUGIN_HANDLER_TIMEOUT_MS,
  type PluginHandler, type PluginHandlerInput, type PluginHandlerModule, type PluginHandlerRun, type PluginJsonValue, type PluginLogLine, type PluginManifest,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';
import { buildPluginContext, retainForRedaction, type PluginContextDeps, type PluginInstallationTarget } from './pluginContext.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';

/** The handlers module of a plugin (its `handlers.ts`), or null when it has none. */
export type PluginHandlerSource = (pluginId: string) => Promise<PluginHandlerModule | null>;

interface PluginRegistryHandlers { loadPluginHandlers(id: string): Promise<PluginHandlerModule | null> }
// Not a literal import, like the catalog: Core runs where the registry package is absent.
const REGISTRY_MODULE = '@propr/plugins';

/** The handlers of the official plugin registry (`@propr/plugins`). */
export const officialPluginHandlers: PluginHandlerSource = async pluginId => {
  const registry = await import(REGISTRY_MODULE) as PluginRegistryHandlers;
  return registry.loadPluginHandlers(pluginId);
};

export interface RunPluginHandlerOptions extends PluginContextDeps {
  /** Where handler modules come from; defaults to the official registry. */
  handlers?: PluginHandlerSource;
  /** The manifests, when the installation is given by plugin id; defaults to the official catalog. */
  catalog?: PluginCatalogSource;
  /** Defaults to `PLUGIN_HANDLER_TIMEOUT_MS`; tests shorten it. */
  timeoutMs?: number;
}

/** A plugin id (its installation is read from the database) or an installation already loaded. */
export type PluginInstallationRef = string | PluginInstallationTarget;

const HANDLER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ERROR_CHARS = 1_000;
const RESULT_BYTES = 16 * 1024;

class HandlerTimeout extends Error { constructor(ms: number) { super(`The handler did not finish within ${Math.round(ms / 1000)} seconds`); } }

async function loadTarget(installation: PluginInstallationRef, database: Knex, catalog: PluginCatalogSource): Promise<PluginInstallationTarget> {
  if (typeof installation !== 'string') return installation;
  const manifest: PluginManifest | undefined = (await catalog()).find(m => m.id === installation);
  if (!manifest) throw new Error(`Plugin ${installation.slice(0, 48)} is not in this ProPR's registry`);
  const row = await database('plugin_installations').where({ plugin_id: installation }).first() as PluginInstallationRow | undefined;
  if (!row) throw new Error(`Plugin ${installation} is not installed`);
  return { pluginId: installation, manifest, record: installationRecord(row) };
}

async function loadHandler(target: PluginInstallationTarget, name: string, source: PluginHandlerSource): Promise<PluginHandler> {
  if (!target.record.enabled) throw new Error(`Plugin ${target.pluginId} is not enabled`);
  if (!HANDLER_NAME.test(name)) throw new Error('Invalid handler name');
  const module = await source(target.pluginId);
  const handler = module && Object.hasOwn(module, name) ? module[name] : undefined;
  if (typeof handler !== 'function') throw new Error(`Plugin ${target.pluginId} has no handler ${name}`);
  return handler;
}

/** The handler's return value as JSON, or an error when it is not JSON or too large. */
function resultValue(value: unknown): PluginJsonValue | undefined {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { /* not JSON */ }
  if (text === undefined) throw new Error('The handler returned a value that is not JSON');
  if (Buffer.byteLength(text) > RESULT_BYTES) throw new Error(`The handler returned more than ${RESULT_BYTES} bytes`);
  return JSON.parse(text) as PluginJsonValue;
}

// Kept past ERROR_CHARS: `finish` cuts it only after redacting it, so a credential straddling the limit is redacted whole.
const message = (error: unknown) => retainForRedaction(error instanceof Error ? error.message : String(error), ERROR_CHARS) || 'The handler failed';

/** Run the handler, failing it once it runs past `timeoutMs`; the signal tells the handler to stop. */
async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { const error = new HandlerTimeout(timeoutMs); controller.abort(error); reject(error); }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Run one handler of an installed, enabled plugin: load it from the registry,
 * build its `ctx`, apply the time limit and return the outcome, duration,
 * error message and log lines. Never throws; every failure, a timeout
 * included, is a `failed` outcome. Messages, logs and the result are redacted.
 */
export async function runPluginHandler(installation: PluginInstallationRef, handlerName: string, input: PluginHandlerInput, options: RunPluginHandlerOptions): Promise<PluginHandlerRun> {
  const started = performance.now();
  const controller = new AbortController();
  let finalLogs = (): PluginLogLine[] => [];
  let redact = <T>(value: T): T => value;
  let clip = (text: string, limit: number): string => text.slice(0, limit);
  const pluginId = typeof installation === 'string' ? installation : installation?.pluginId;
  const finish = (run: Omit<PluginHandlerRun, 'durationMs' | 'logs'>): PluginHandlerRun => {
    const durationMs = Math.round(performance.now() - started);
    // Ends the run for anything the handler left running: ctx refuses further calls and log lines.
    if (!controller.signal.aborted) controller.abort(new Error('The handler run has ended'));
    // Lines logged (and errors raised) before a credential was acquired were redacted without it: redact them again with all the credentials of this run, then cut them.
    const result: PluginHandlerRun = { ...run, error: run.error === null ? null : clip(run.error, ERROR_CHARS), durationMs, logs: finalLogs() };
    try { logger.info({ pluginId, handler: handlerName, outcome: result.outcome, timedOut: result.timedOut, durationMs }, '[plugins] Handler run'); } catch { /* logging never fails a run */ }
    return result;
  };
  try {
    const target = await loadTarget(installation, options.database, options.catalog ?? officialPluginCatalog);
    const handler = await loadHandler(target, handlerName, options.handlers ?? officialPluginHandlers);
    const built = buildPluginContext(target, options, handlerName, controller.signal);
    finalLogs = built.finalLogs; redact = built.redact; clip = built.clip;
    const value = await withTimeout(() => handler(input, built.ctx), options.timeoutMs ?? PLUGIN_HANDLER_TIMEOUT_MS, controller);
    const result = resultValue(value);
    return finish({ outcome: 'succeeded', timedOut: false, error: null, ...(result === undefined ? {} : { result: redact(result) }) });
  } catch (error) {
    return finish({ outcome: 'failed', timedOut: error instanceof HandlerTimeout, error: message(error) });
  }
}
