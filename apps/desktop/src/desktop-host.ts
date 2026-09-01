import { ConfigManager } from '@propr/cli/dist/config/index.js';
import { loginWithGithubCli } from '@propr/cli/dist/auth/githubLogin.js';
import { configureStackTemplatePath } from '@propr/cli/dist/commands/initStack.js';
import { createDefaultActions } from '@propr/cli/dist/commands/setup/hostActions.js';
import { configureOrchestratorAssetPath, getHostConfig } from '@propr/cli/dist/orchestrator/index.js';
import { localhostServiceUrl } from '@propr/cli/dist/utils/dockerPort.js';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SetupActions } from '@propr/local-setup';
import type { LocalLifecycleHost } from './lifecycle';
import { bindRootOperations, RootDirectoryAuthority } from './setup-capabilities';

export interface DesktopLocalHost {
  actions: SetupActions;
  config: ConfigManager;
  lifecycle: LocalLifecycleHost;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
}

const canonicalResource = async (
  root: string,
  segments: readonly string[],
  expected: 'file' | 'directory',
): Promise<string> => {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new Error('Packaged local-setup resources must not contain symbolic links');
    const isLast = index === segments.length - 1;
    if ((!isLast || expected === 'directory') && !stats.isDirectory()) {
      throw new Error('Packaged local-setup resource directory is invalid');
    }
    if (isLast && expected === 'file' && !stats.isFile()) {
      throw new Error('Packaged local-setup resource file is invalid');
    }
  }
  const canonical = await realpath(current);
  const scope = relative(root, canonical);
  if (!scope || scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope)) {
    throw new Error('Packaged local-setup resource escaped resourcesPath');
  }
  return canonical;
};

export const resolvePackagedSetupResources = async (resourcesPath: string): Promise<{
  orchestratorPath: string;
  stackTemplatePath: string;
}> => {
  const root = await realpath(resourcesPath);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Packaged resourcesPath is invalid');
  const [orchestratorPath, stackTemplatePath] = await Promise.all([
    canonicalResource(root, ['orchestrator', 'orchestrator.mjs'], 'file'),
    canonicalResource(root, ['assets', 'env.example.txt'], 'file'),
  ]);
  return { orchestratorPath, stackTemplatePath };
};

/** Bind the portable setup engine to the same launcher used by the CLI. */
export async function createDesktopLocalHost(resourcesPath?: string, defaultRootDir?: string, appDataDir = defaultRootDir ? dirname(defaultRootDir) : undefined): Promise<DesktopLocalHost> {
  if (resourcesPath) {
    const packagedResources = await resolvePackagedSetupResources(resourcesPath);
    configureOrchestratorAssetPath(packagedResources.orchestratorPath);
    configureStackTemplatePath(packagedResources.stackTemplatePath);
  }
  const config = new ConfigManager();
  await config.init();
  const defaultActions = createDefaultActions(config);
  const actions: SetupActions = {
    ...defaultActions,
    async loginWithGithub({ onLog, signal } = {}) {
      // A packaged GUI has no controlling terminal. Reuse an existing gh
      // session, but leave an actionable recovery step instead of launching an
      // invisible interactive process when the user is not signed in.
      const result = await loginWithGithubCli(config, { interactive: false, onLog, signal });
      if (!result.ok) onLog?.(result.message);
      return result.ok;
    },
    async startStack(params) {
      params.signal?.throwIfAborted();
      params.assertRootAuthority?.();
      const { orch, cfg } = await getHostConfig({ configManager: config, root: params.rootDir, readRoot: params.rootOperationsDir });
      params.assertRootAuthority?.();
      const recovered = await orch.recoverStackAsync(cfg, {
        ui: params.ui ?? config.getUiEnabled() ?? true,
        docs: params.docs ?? cfg.docsEnabled,
        signal: params.signal,
        onLog: params.onLog,
        assertRootAuthority: params.assertRootAuthority,
      });
      params.assertRootAuthority?.();
      if (!recovered.recovered) await defaultActions.startStack(params);
    },
  };

  const root = (): string => {
    if (!defaultRootDir) throw new Error('No fixed local ProPR runtime root is configured');
    return resolve(defaultRootDir);
  };

  const withFixedRoot = async <T>(operation: (authority: RootDirectoryAuthority, displayRoot: string) => Promise<T>): Promise<T> => {
    const displayRoot = root();
    const authority = RootDirectoryAuthority.open(displayRoot, true, appDataDir);
    try { return await operation(authority, displayRoot); } finally { authority.close(); }
  };

  return {
    actions,
    config,
    async resolveApiBaseUrl(rootDir, signal) {
      return withFixedRoot(async (authority, displayRoot) => {
        if (resolve(rootDir) !== displayRoot) throw new Error('The local profile root is not the fixed desktop runtime root');
        signal?.throwIfAborted();
        authority.validate();
        const { cfg } = await getHostConfig({ configManager: config, root: displayRoot, readRoot: authority.operationPath() });
        authority.validate();
        signal?.throwIfAborted();
        return localhostServiceUrl(cfg.apiPort);
      });
    },
    lifecycle: {
      async running(signal) {
        return withFixedRoot(async (authority, displayRoot) => {
          signal?.throwIfAborted();
          authority.validate();
          const { orch, cfg } = await getHostConfig({ configManager: config, root: displayRoot, readRoot: authority.operationPath() });
          authority.validate();
          return orch.isLifecycleStackRunningAsync(cfg, { signal, assertRootAuthority: () => authority.validate() });
        });
      },
      async start(signal) {
        await withFixedRoot((authority, displayRoot) => bindRootOperations(actions, displayRoot, authority).startStack({ rootDir: displayRoot, signal }));
      },
      async stop(signal) {
        await withFixedRoot(async (authority, displayRoot) => {
          signal?.throwIfAborted();
          authority.validate();
          const { orch, cfg } = await getHostConfig({ configManager: config, root: displayRoot, readRoot: authority.operationPath() });
          authority.validate();
          const { failed } = await orch.stopLifecycleStackAsync(cfg, { signal, assertRootAuthority: () => authority.validate() });
          authority.validate();
          signal?.throwIfAborted();
          if (failed.length) throw new Error(`Could not stop ${failed.join(', ')}`);
        });
      },
    },
  };
}
