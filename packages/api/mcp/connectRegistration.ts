import type { Knex } from 'knex';
import { db } from '@propr/core';
import { McpError, type McpConfig } from './config.js';
import { getMcpTunnelSetupErrorSync, resolveMcpConfig } from './configResolver.js';
import { McpConnect, onConnectRegistrationRejected, registerMcpInstance } from './connect.js';
import { McpStore } from './store.js';
import {
  getConnectMcpState, isHostedTunnelMode, isTunnelDerivedInstanceId, McpSetupError, setConnectMcpState,
  type ConnectMcpState,
} from './tunnelMode.js';

/** A current registration is re-sent this often, so Connect never holds a stale one for long. */
export const CONNECT_REGISTRATION_REFRESH_MS = 24 * 60 * 60 * 1000;
export const CONNECT_REGISTRATION_RETRY_BASE_MS = 5_000;
export const CONNECT_REGISTRATION_RETRY_MAX_MS = 15 * 60 * 1000;
/** Repeated 409 rejections from request traffic re-register at most this often. */
const REJECTION_REREGISTER_INTERVAL_MS = 60_000;

/** Exponential backoff after the given number of consecutive failures (1-based). */
export function connectRegistrationRetryDelayMs(failures: number): number {
  return Math.min(CONNECT_REGISTRATION_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), CONNECT_REGISTRATION_RETRY_MAX_MS);
}

export interface ConnectRegistrationOptions {
  database?: Knex;
  env?: NodeJS.ProcessEnv;
  resolveConfig?: (database: Knex, env: NodeJS.ProcessEnv) => Promise<McpConfig | null>;
  register?: typeof registerMcpInstance;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export interface ConnectRegistrationManager {
  /** Check now (startup, Settings change, rejection). Concurrent calls coalesce. */
  trigger(): Promise<ConnectMcpState>;
  stop(): void;
  state(): ConnectMcpState;
  /** Delay of the currently scheduled retry or refresh, if any. */
  scheduledDelayMs(): number | undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof McpSetupError || error instanceof McpError) return error.code;
  return 'REGISTRATION_FAILED';
}

/**
 * Keeps this instance registered with ProPR Connect in hosted UI tunnel mode,
 * running the same flow as `npm run mcp:connect:register`. It is idempotent: a
 * current registration that matches the configuration is left alone. A missing,
 * stale, or rejected registration, or one for another tunnel id, is renewed.
 * Failures retry with exponential backoff. Outside tunnel mode it only reports
 * the state of a manually registered instance and never registers by itself.
 */
export function startConnectMcpRegistration(options: ConnectRegistrationOptions = {}): ConnectRegistrationManager {
  const {
    database = db,
    env = process.env,
    resolveConfig = resolveMcpConfig,
    register = registerMcpInstance,
    now = Date.now,
    setTimer = (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
    clearTimer = handle => clearTimeout(handle as NodeJS.Timeout),
    logger = console,
  } = options;
  let failures = 0;
  let timer: unknown;
  let delay: number | undefined;
  let running: Promise<ConnectMcpState> | undefined;
  let rerun = false;
  let stopped = false;
  let forceRegister = false;
  let lastRegistrationAt = 0;

  const automatic = () => isHostedTunnelMode(env) && env.MCP_ENABLED !== 'false';

  function setState(next: ConnectMcpState): void {
    if (next !== getConnectMcpState()) logger.info(`[mcp] connect_mcp: ${next}`);
    setConnectMcpState(next);
  }

  function cancelTimer(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    delay = undefined;
  }

  function schedule(ms: number): void {
    cancelTimer();
    if (stopped) return;
    delay = ms;
    timer = setTimer(() => { timer = undefined; delay = undefined; void trigger(); }, ms);
  }

  /** Resolves to the new state, or throws with the failure; `current` tells whether a valid registration remains. */
  async function attempt(): Promise<{ state: ConnectMcpState; current: boolean; error?: unknown }> {
    if (env.MCP_ENABLED === 'false') return { state: 'disabled', current: false };
    let config: McpConfig | null;
    try { config = await resolveConfig(database, env); }
    catch (error) { return { state: `failed:${errorCode(error)}`, current: false, error }; }
    if (!config) {
      const setupError = automatic() ? getMcpTunnelSetupErrorSync() : undefined;
      return setupError ? { state: `failed:${setupError}`, current: false, error: new McpSetupError(setupError, setupError) } : { state: 'disabled', current: false };
    }
    if (!config.connect) return { state: 'disabled', current: false };
    const store = new McpStore(database, config.encryptionKey);
    const connect = new McpConnect(config, store);
    let current = false;
    try {
      await connect.registeredThumbprint();
      current = true;
    } catch (error) {
      if (!(error instanceof McpError && error.code === 'CONNECT_SETUP_REQUIRED')) {
        return { state: `failed:${errorCode(error)}`, current: false, error };
      }
    }
    if (!automatic()) return { state: current ? 'registered' : 'pending', current };
    const registeredAt = current ? await connect.registeredAt() : undefined;
    const stale = registeredAt === undefined || now() - registeredAt >= CONNECT_REGISTRATION_REFRESH_MS;
    if (current && !stale && !forceRegister) return { state: 'registered', current };
    forceRegister = false;
    if (!current) setState('pending');
    try {
      lastRegistrationAt = now();
      await register(config, store, { replaceIdentity: isTunnelDerivedInstanceId(env) });
      return { state: 'registered', current: true };
    } catch (error) {
      return { state: `failed:${errorCode(error)}`, current, error };
    }
  }

  async function runOnce(): Promise<void> {
    cancelTimer();
    const result = await attempt().catch((error: unknown) => ({ state: `failed:${errorCode(error)}` as ConnectMcpState, current: false, error }));
    if (stopped) return;
    if (!result.state.startsWith('failed:')) {
      failures = 0;
      setState(result.state);
      if (result.state === 'registered' && automatic()) schedule(CONNECT_REGISTRATION_REFRESH_MS);
      return;
    }
    if (!automatic()) { setState(result.state); return; }
    failures += 1;
    const retryIn = connectRegistrationRetryDelayMs(failures);
    // A refresh that could not reach Connect leaves the existing registration usable.
    const transient = result.current && result.state === 'failed:CONNECT_UNAVAILABLE';
    setState(transient ? 'registered' : result.state);
    const detail = result.error instanceof McpSetupError ? ` ${result.error.message}` : '';
    logger.warn(`[mcp] Connect registration ${result.state.slice('failed:'.length)};${detail} retrying in ${Math.round(retryIn / 1000)}s`);
    schedule(retryIn);
  }

  function trigger(): Promise<ConnectMcpState> {
    if (stopped) return Promise.resolve(getConnectMcpState());
    if (running) { rerun = true; return running; }
    running = (async () => {
      try {
        do { rerun = false; await runOnce(); } while (rerun && !stopped);
      } finally { running = undefined; }
      return getConnectMcpState();
    })();
    return running;
  }

  onConnectRegistrationRejected(() => {
    if (stopped || !automatic()) return;
    forceRegister = true;
    const since = now() - lastRegistrationAt;
    if (since >= REJECTION_REREGISTER_INTERVAL_MS) void trigger();
    else if (delay === undefined || delay > REJECTION_REREGISTER_INTERVAL_MS - since) schedule(REJECTION_REREGISTER_INTERVAL_MS - since);
  });

  return {
    trigger,
    stop() {
      stopped = true;
      cancelTimer();
      onConnectRegistrationRejected(undefined);
    },
    state: getConnectMcpState,
    scheduledDelayMs: () => delay,
  };
}
