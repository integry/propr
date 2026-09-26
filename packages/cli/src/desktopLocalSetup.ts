import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SetupActions } from '@propr/local-setup';
import {
  evaluateProprApiCompatibility,
  parseProprDesktopDiscoveryJson,
  PROPR_API_COMPATIBILITY,
  PROPR_CONNECT_DISCOVERY_MAX_BYTES,
} from '@propr/shared';
import { ConfigManager } from './config/index.js';
import { configureStackTemplatePath } from './commands/initStack.js';
import { createDefaultActions } from './commands/setup/hostActions.js';
import {
  configureOrchestratorAssetPath,
  configureOrchestratorManifestPath,
  getHostConfig,
} from './orchestrator/index.js';
import { localhostServiceUrl } from './utils/dockerPort.js';
import type { AuthenticationCommandHandoff, CapturedCommandRunner } from './auth/githubLogin.js';

export type { AuthenticationCommandHandoff } from './auth/githubLogin.js';

export interface DesktopSetupHost {
  actions: SetupActions;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
}

const verifiedResource = (path: string): string => {
  if (!existsSync(path)) throw new Error('Packaged local-setup resource is unavailable');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Packaged local-setup resource is invalid');
  return realpathSync(path);
};

export interface DesktopRuntimeCompatibilityResult {
  compatible: boolean;
  detail: string;
  nextAction?: string;
  recoveryAction?: 'replace-running-stack';
}

const incompatibleRuntime = (
  image: string,
  reason: string,
  replaceRunningStack = false,
): DesktopRuntimeCompatibilityResult => ({
  compatible: false,
  detail: `desktop runtime ${image} is incompatible: ${reason}`,
  nextAction: replaceRunningStack
    ? `After aligned images for API compatibility ${PROPR_API_COMPATIBILITY} are available, choose Restart with aligned runtime. Source builds can use \`npm run desktop:runtime:build\` and package with its generated manifest. Only this Desktop-managed stack's containers are replaced; data and credentials are retained.`
    : `Install the app image released for API compatibility ${PROPR_API_COMPATIBILITY}, then retry local setup. Source builds can use \`npm run desktop:runtime:build\` and package with its generated manifest.`,
  ...(replaceRunningStack ? { recoveryAction: 'replace-running-stack' as const } : {}),
});

const unavailableRuntime = (image: string, reason: string): DesktopRuntimeCompatibilityResult => ({
  compatible: false,
  detail: `desktop runtime ${image} could not be verified: ${reason}`,
  nextAction: 'Retry local setup. If this persists, inspect the Desktop-managed API and identity persistence health; the existing runtime and data have been retained.',
});

const transientDiscoveryStatus = (status: number): boolean => (
  status === 408 || status === 425 || status === 429 || status >= 500
);

const LEGACY_DISCOVERY_AUTH_VERSIONS = new Set(['0.8.15']);

const readBoundedJsonObject = async (
  response: Response,
  callerSignal?: AbortSignal,
): Promise<Record<string, unknown> | null> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const declared = response.headers.get('content-length');
  if (contentType !== 'application/json'
    || (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared)
      || Number(declared) > PROPR_CONNECT_DISCOVERY_MAX_BYTES))) {
    try { await response.body?.cancel(); } catch { /* best-effort disposal */ }
    return null;
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > PROPR_CONNECT_DISCOVERY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    return null;
  } finally {
    try { reader?.releaseLock(); } catch { /* response already cancelled */ }
  }
  if (declared !== null && Number(declared) !== received) return null;
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const isVerifiedLegacyCompatibility = (value: Record<string, unknown> | null): boolean => {
  if (!value || Object.keys(value).some(key => !['version', 'apiCompatibility', 'uiCompatibility'].includes(key))) return false;
  return typeof value.version === 'string'
    && LEGACY_DISCOVERY_AUTH_VERSIONS.has(value.version)
    && value.apiCompatibility === PROPR_API_COMPATIBILITY
    && value.uiCompatibility === PROPR_API_COMPATIBILITY;
};

const verifyLegacyDiscoveryAuthentication = async (
  options: Parameters<typeof checkDesktopRuntimeCompatibility>[0],
  signal: AbortSignal,
): Promise<boolean> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      new URL('/api/compatibility', options.baseUrl),
      {
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
        redirect: 'manual',
        signal,
      },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return false;
  }
  if (!response.ok || response.redirected) {
    try { await response.body?.cancel(); } catch { /* best-effort disposal */ }
    return false;
  }
  return isVerifiedLegacyCompatibility(await readBoundedJsonObject(response, options.signal));
};

/**
 * Probe the complete public desktop contract, not only the protected health
 * route.  This is intentionally strict: a legacy compatibility document is not
 * evidence of discovery, identity, pairing, REST bearer, or Socket.IO support.
 */
export async function checkDesktopRuntimeCompatibility(options: {
  baseUrl: string;
  image: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<DesktopRuntimeCompatibilityResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      new URL('/api/desktop/discovery', options.baseUrl),
      {
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
        redirect: 'manual',
        signal,
      },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return unavailableRuntime(options.image, signal.aborted
      ? 'the desktop discovery check timed out'
      : 'the desktop discovery endpoint could not be reached');
  }
  if (!response.ok || response.redirected) {
    try { await response.body?.cancel(); } catch { /* best-effort disposal */ }
    const reason = `the public desktop discovery endpoint returned HTTP ${response.status}`;
    if (transientDiscoveryStatus(response.status)) return unavailableRuntime(options.image, reason);
    if (response.status === 404) return incompatibleRuntime(options.image, reason, true);
    if (response.status === 401 && await verifyLegacyDiscoveryAuthentication(options, signal)) {
      return incompatibleRuntime(
        options.image,
        `${reason}; bounded public compatibility metadata identifies legacy ProPR 0.8.15 without desktop authentication capabilities`,
        true,
      );
    }
    return unavailableRuntime(options.image, reason);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const declared = response.headers.get('content-length');
  if (contentType !== 'application/json'
    || (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared)
      || Number(declared) > PROPR_CONNECT_DISCOVERY_MAX_BYTES))) {
    try { await response.body?.cancel(); } catch { /* best-effort disposal */ }
    return incompatibleRuntime(options.image, 'the public desktop discovery response is invalid', true);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > PROPR_CONNECT_DISCOVERY_MAX_BYTES) {
        await reader.cancel();
        return incompatibleRuntime(options.image, 'the public desktop discovery response is oversized', true);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return unavailableRuntime(options.image, 'the public desktop discovery response could not be read');
  } finally {
    try { reader?.releaseLock(); } catch { /* response already cancelled */ }
  }
  if (declared !== null && Number(declared) !== received) {
    return incompatibleRuntime(options.image, 'the public desktop discovery response length is invalid', true);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let contents: string;
  try { contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return incompatibleRuntime(options.image, 'the public desktop discovery response is not valid UTF-8', true); }
  const discovery = parseProprDesktopDiscoveryJson(contents);
  if (!discovery) {
    return incompatibleRuntime(options.image, 'it does not expose the required discovery, identity, and desktop authentication contract', true);
  }
  const compatibility = evaluateProprApiCompatibility(discovery);
  if (!compatibility.compatible) return incompatibleRuntime(options.image, compatibility.message, true);
  if (!discovery.desktopAuthentication.browserPairing
    || !discovery.desktopAuthentication.instanceBearerTokens
    || !discovery.desktopAuthentication.socketIoBearerAuthentication) {
    return incompatibleRuntime(options.image, 'it does not enable browser pairing, REST bearer tokens, and Socket.IO bearer authentication', true);
  }
  return {
    compatible: true,
    detail: `desktop contract ready (API ${discovery.apiCompatibility}, pairing protocol ${discovery.desktopAuthentication.protocolVersion})`,
  };
}

/** Build the real CLI setup host without exposing command execution to the renderer. */
export async function createDesktopSetupHost(options: {
  configDir: string;
  resourcesPath?: string;
  runtimeManifestPath?: string;
  authenticationHandoff: AuthenticationCommandHandoff;
  capturedCommand?: CapturedCommandRunner;
}): Promise<DesktopSetupHost> {
  if (options.resourcesPath) {
    const root = realpathSync(options.resourcesPath);
    configureOrchestratorAssetPath(verifiedResource(join(root, 'orchestrator.mjs')));
    configureOrchestratorManifestPath(verifiedResource(join(root, 'manifest.json')));
    configureStackTemplatePath(verifiedResource(join(root, 'assets', 'env.example.txt')));
  } else if (options.runtimeManifestPath) {
    configureOrchestratorManifestPath(verifiedResource(options.runtimeManifestPath));
  }
  const config = new ConfigManager(resolve(options.configDir));
  await config.init();
  const baseActions = createDefaultActions(config, {
    authenticationHandoff: options.authenticationHandoff,
    capturedCommand: options.capturedCommand,
  });
  const actions: SetupActions = {
    ...baseActions,
    async checkBackendHealth(params) {
      const health = await baseActions.checkBackendHealth(params);
      if (!health.healthy) return health;
      const { cfg } = await getHostConfig({ configManager: config, root: params.rootDir });
      const baseUrl = localhostServiceUrl(cfg.apiPort);
      const desktop = await checkDesktopRuntimeCompatibility({
        baseUrl,
        image: cfg.images.app ?? 'unknown app image',
        signal: params.signal,
      });
      return desktop.compatible
        ? { ...health, detail: `${health.detail}; ${desktop.detail}` }
        : {
            healthy: false,
            detail: desktop.detail,
            nextAction: desktop.nextAction,
            recoveryAction: desktop.recoveryAction,
          };
    },
  };
  return {
    actions,
    async resolveApiBaseUrl(rootDir, signal) {
      signal?.throwIfAborted();
      const { cfg } = await getHostConfig({ configManager: config, root: rootDir });
      signal?.throwIfAborted();
      return localhostServiceUrl(cfg.apiPort);
    },
  };
}
